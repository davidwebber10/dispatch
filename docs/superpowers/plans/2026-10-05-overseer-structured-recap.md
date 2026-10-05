# Overseer structured recap and decision ledger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every overseer reports one structured recap per settled batch of agent work, and every user decision it cites carries the user's exact words, checked by the daemon against a log of what the user really sent.

**Architecture:** A new `coordinator_messages` table logs every message that reaches an overseer, at the one write point all structured sends share. A new `ledger_items` table holds decisions and statements; a pure quote matcher and a pure renderer feed a `LedgerService` behind overseer-only REST routes, which five new dispatch MCP tools call. Every agent notice gains a daemon-computed Batch line, a 60-second sweep sends one interim recap notice after 20 minutes, and the coordinator persona and the web stream learn the new contract.

**Tech Stack:** TypeScript (ESM, Node 18+), better-sqlite3, Express, vitest (+ supertest in core, Testing Library and jsdom in web), React 18 with zustand, a hand-rolled stdio JSON-RPC MCP server.

Spec: `docs/superpowers/specs/2026-10-05-overseer-structured-recap-design.md` (including decision 5 and Unit 2 rule 7, commit `f0a07a2`).

## Global Constraints

- Work only in the worktree `/Users/jdetamore/Developer/Projects/dispatch/.claude/worktrees/overseer-recap` (branch `docs/overseer-structured-recap`). It has no `node_modules` yet: run `pnpm install` once at the worktree root before Task 1.
- Line numbers in this plan refer to the files as they are before Task 1. Earlier tasks shift them, so always find the place by the quoted text.
- Run tests from inside a package: `cd packages/core && npx vitest run <path>` and `cd packages/web && npx vitest run <path>`. Never run vitest from the repo root (it breaks the web tests).
- Typecheck core with `cd packages/core && npx tsc --noEmit -p .` (this also checks `src/**/*.test.ts`; files under `packages/core/tests/` are not typechecked). Typecheck web with `cd packages/web && npx tsc -b`. Do not run the web `vite build`.
- Every relative import in `packages/core/src` ends in `.js` (`tests/esm-import-extensions.test.ts` enforces it).
- Never start a daemon against the real `~/.dispatch`. A test that spawns the fake CLI passes a temporary `secretsDir`. A test deletes only the `fs.mkdtempSync` directory it made itself.
- The GitHub repo is public: no customer, business, product or person names in code, tests, comments or commit messages.
- Settled = no agent of the overseer is working or queued. The limit is 20 minutes: `INTERIM_RECAP_MS = 20 * 60_000`. The sweep runs every 60 seconds (`60_000` ms).
- Migration: `migrate(db, '005-coordinator-messages-and-ledger', …)` in `packages/core/src/db/schema.ts`. Never the legacy `migrations` column array (it reaches only new databases).
- Message log `source` values: `user`, `canned`, `coordinator`, `daemon`. A send with no `source` is `daemon`. An image block is logged as `[image]`. Text blocks are joined with `\n`.
- The log is written in `SessionService.sendStructuredMessage`, after `manager.sendMessage` returns, only for a terminal with `config.role === 'coordinator'`. A write failure is logged with `console.error` and never blocks the send.
- The canned need-card acknowledgement sends body `canned: true`. The `MessageSource` type stays `'user' | 'coordinator'`; the "via Dispatch" badge does not change.
- Ledger IDs are `N<seq>`, with `seq` counted per project (session) and never repeated.
- Ledger `kind`: `go`, `decide`, `do`, `statement`. `status`: `open`, `answered`, `parked`, `withdrawn`, `superseded`. `origin`: `live`, `imported`. Item `text` never changes after creation.
- Labels, exact: `You said: "<quote>" (Mon 16:51)` for a statement; `You approved: "<text>" → "<quote>" (Mon 16:51)` for `answered` on `go`/`decide`; `Proposed by <author>, not approved` for `open`; `I read this as: …` on its own line, only when `reading` is set; `Imported, not checked`; `Withdrawn by overseer: …`.
- Recap sections, in this order: `Needs you now`, `Your tests and actions`, `Decided since the last recap`, `Parked`.
- 403 text: `Only the project's overseer can change the ledger.` Unknown ID: 404 `Unknown ledger item: N<seq>`. Closed item: 409 `N<seq> is already <status>.` with `status` in the body.
- Quote not found (422): `Quote not found in the user's messages to you after N12 was created. Do not record it. Ask the user.` (with the real item ID).
- Leading ok-words: `ok`, `okay`, `k`, `kk`, in any case, then any punctuation and spaces. They are removed only when the quote match starts at the beginning of the message. Failure text (422): `An 'ok' at the start of a message is not an answer. Ask the user.`
- A `go` item becomes `answered` only when the quote (after the ok-word removal) contains its ID (such as `N12`) or one of the whole words `merge`, `deploy`, `release`, `push`, `restart`, `update` (case-insensitive; "emerged" does not count). Failure text (422): `A go item needs its ID or the action word in the user's answer. A bare yes is not enough. Ask the user.` `parked` on a `go` item does not need it. (Task 12.)
- New MCP tools: `ledger_add`, `ledger_resolve`, `ledger_note`, `ledger_list`, `ledger_import`. The tool count goes from 17 to 22. `spawn_agent`, `queue_agent` and `message_agent` gain `ledgerIds?`.
- Hand-off block header, exact: `Owner decisions (verbatim, from the ledger):`
- Notice prefixes: Finished `✅`, Blocked `⏸️`, Question `🔔`, Stopped `⚠️`, Direct message `💬`, Interim recap `🕒`.
- The Finished notice drops "or report back to the user".
- Batch line texts, verbatim from the spec (busy, then settled):

```text
Batch: still working — 2 agents ("Build X", "Review Y"); 1 queued.
Do not post a recap. If this needs a decision, add it with ledger_add
and post only that item. Otherwise write at most one line.
Open ledger items: N3, N7.
```

```text
Batch: no other agent is working or queued.
If you start a next step now, write at most one line.
If you start nothing, the batch has settled: post the recap now
(ledger_list with forRecap, and list_agents).
Open ledger items: N3, N7.
```

- Interim recap notice, verbatim:

```text
🕒 Interim recap due: agent turns finished 20 minutes ago, and 2 agents
still work. Post the recap now and mark it "interim". Then keep holding.
```

- The Codex persona variant is built with `indexOf`/`replace` on these exact strings in `COORDINATOR_PROMPT`; keep every one: `'Each type defaults to a sensible model tier '`, `'only to override that default when a task is unusually easy or hard for its role.\n'`, `'MODEL ECONOMY: the per-type default model is often too big for the task. '`, `'status checks and "did last night'`, `'the opus defaults for genuine investigation, planning, and judgment.'`, `'when you hit a denial, spawn the right agent instead of retrying.\n\n'`.
- Every commit message ends with a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Do not merge, push to `main`, release or deploy. The persona applies to a running overseer only after its process restarts; a deploy needs the user's own approval.

---

## Decisions this plan makes where the spec is silent

Reviewers can reject any of these on its own.

1. **Hand-off rendering.** The daemon renders the hand-off block (`POST /api/sessions/:sessionId/ledger/handoff`); the dispatch MCP appends it to the task or message text before it creates or messages anything. An unknown ID fails the tool before a thread exists.
2. **Statements** are stored with `status: 'answered'`, `author: 'you'`, and `text` equal to the checked quote.
3. **"Decided since the last recap"** lists `answered` and `withdrawn` items whose `updated_at` is after the overseer's `lastRecapAt` (all of them when there was no recap yet). A withdrawn item therefore shows in one recap only.
4. **Supersedes.** A new item that supersedes an `open` item marks the old item `superseded`. An answered or parked old item keeps its status (the user's earlier answer stays true for the narrow scope).
5. **Imported items.** An imported item with no checked quote can be resolved once more: `answered` or `parked` with a quote confirms it, `withdrawn` drops it.
6. **Quote-check failures return HTTP 422.** For `ledger_note` (no item exists yet) the text is `Quote not found in the user's messages to you. Do not record it. Ask the user.`
7. **The stored quote** is the user's own text for the matched words (their case and spacing), after the ok-word removal.
8. **Waiting on the overseer.** Agents in `needs_input`, or working with a pending question, do not keep a batch busy. The busy line names them as an extra clause (`1 agent waiting on you ("Plan Z")`), and the settled block adds one line (`Still 1 agent waiting on you ("Plan Z").`). With no such agents, both texts are exactly the spec texts.
9. **The notice subject.** The Finished, Blocked, Question and Stopped notices leave their own agent out of the Batch line. A Direct message starts the subject's turn, so that notice counts the subject as working; the Direct message notice is therefore always busy.
10. **Plurals and empties.** One agent reads `1 agent` and `1 agent\nstill works`. No open items reads `Open ledger items: none.`
11. **The interim notice fires only when at least one agent is working** at the due time (queued alone does not fire). The timer clears either way, so it fires at most once.
12. **Persona step 5** ("Done since the last recap") starts with the "Decided since the last recap" lines from `ledger_list`.
13. **`ledger_list` is a POST route**, because `forRecap` changes the overseer's config.
14. **Extra rendered lines:** an open item's first line ends with its age, for example `(open 2h)`; `Recommendation: …`, `Options: A | B`, `Blocks: …`; a parked item shows `Parked by you: "<quote>" (Mon 16:51)`; an answered `do` item shows `You said: "<quote>" (Mon 16:51)`; a superseded item shows `Superseded, not approved`; a superseding item shows `Original question (N3): "<old text>"`.
15. **Withdraw** is allowed on any open item, whoever proposed it.

---

## File Structure

Create (core):

| File | Responsibility |
|---|---|
| `packages/core/src/db/coordinator-messages.ts` | Message log storage: `append`, `listForTerminal`, `listUserMessages`, `messageText`. |
| `packages/core/src/db/ledger.ts` | Ledger storage: per-project `seq`, create, read, status change. Types `LedgerItem`, `LedgerKind`, `LedgerStatus`. |
| `packages/core/src/overseer/ledger-quote.ts` | Pure quote check (rules 2 and 6). Task 12 adds the `go` rule (rule 7). |
| `packages/core/src/overseer/ledger-render.ts` | Pure renderer: item lines, recap sections, hand-off block. |
| `packages/core/src/overseer/ledger-service.ts` | The ledger rules: overseer-only check, quote checks, errors, `forRecap` stamping. |
| `packages/core/src/routes/ledger.ts` | HTTP routes for the ledger. |
| `packages/core/src/sessions/batch-state.ts` | Batch state (working / queued / waiting) and the Batch footer text. |
| `packages/core/src/sessions/interim-recap.ts` | Interim timer logic, the notice text, the 60-second sweep. |

Create (tests):

| File | Covers |
|---|---|
| `packages/core/tests/db/ledger.test.ts` | Migration 005, `seq`, text immutability, status changes, supersedes. |
| `packages/core/tests/db/coordinator-messages.test.ts` | Log storage, four sources, `messageText`. |
| `packages/core/tests/sessions/coordinator-message-log.test.ts` | The write point in `SessionService`. |
| `packages/core/tests/routes/message-canned.test.ts` | The `canned: true` body flag. |
| `packages/core/tests/overseer/ledger-quote.test.ts` | Quote matcher. |
| `packages/core/tests/overseer/ledger-render.test.ts` | Renderer. |
| `packages/core/tests/overseer/ledger-service.test.ts` | Ledger rules. |
| `packages/core/tests/routes/ledger.test.ts` | Route status codes and texts. |
| `packages/core/tests/overseer/agency-mcp-ledger.test.ts` | The five MCP tools and `ledgerIds`. |
| `packages/core/tests/sessions/batch-state.test.ts` | Batch state and footer texts. |
| `packages/core/tests/sessions/notice-batch-line.test.ts` | The footer on all five notices. |
| `packages/core/tests/sessions/interim-recap.test.ts` | Interim timer. |
| `packages/core/src/overseer/prompts.recap.test.ts` | Persona contract substrings. |
| `packages/core/tests/routes/overseer-ledger-e2e.test.ts` | End to end with the fake CLI. |
| `packages/core/tests/overseer/ledger-go-approval.test.ts` | Task 12. |
| `packages/web/src/components/overseer/store-canned-ack.test.ts` | Canned acknowledgement marker. |
| `packages/web/src/components/overseer/components/StreamAgencyNotices.test.tsx` | All six notice types in the stream. |

Modify:

| File | Change |
|---|---|
| `packages/core/src/db/schema.ts:262` | Add migration 005. |
| `packages/core/src/sessions/service.ts` | Log write point, `clock`, Batch line, `batchState`, interim timer hooks. |
| `packages/core/src/routes/terminals.ts:116-135` | Accept `canned: true`. |
| `packages/core/src/server.ts` | Mount the ledger router; start and clear the interim sweep. |
| `packages/core/src/overseer/agency-mcp.ts` | Five tools, `ledgerIds`, ledger request helper. |
| `packages/core/src/overseer/prompts.ts:24-47, 76-82` | Persona contract. |
| `packages/core/src/overseer/prompts.coordinator.test.ts:50-61` | Signature pins and the Codex marker tests. |
| `packages/core/tests/overseer/agency-mcp.test.ts:34-44` | Tool list 17 to 22. |
| `packages/core/src/roles/role-policy.test.ts:392` | Pin: role runs cannot call the ledger tools. |
| `packages/web/src/api/client.ts:97-102` | `sendStructuredMessage(id, content, opts?)`. |
| `packages/web/src/api/client.test.ts` | Two wire tests. |
| `packages/web/src/components/overseer/store.ts:342` | Send the canned marker. |
| `packages/web/src/components/overseer/components/Stream.tsx:26, 210-217, 256-271` | Blocked and Interim recap branches. |

---

### Task 1: Storage — migration 005, message log, ledger

**Files:**
- Modify: `packages/core/src/db/schema.ts:262` (after the `004-lifecycle-runtime` line)
- Create: `packages/core/src/db/coordinator-messages.ts`
- Create: `packages/core/src/db/ledger.ts`
- Test: `packages/core/tests/db/ledger.test.ts`, `packages/core/tests/db/coordinator-messages.test.ts`

**Interfaces:**
- Consumes: `migrate(db, id, apply)` from `packages/core/src/db/migrations.ts:4`.
- Produces (`db/coordinator-messages.ts`):
  - `type CoordinatorMessageSource = 'user' | 'canned' | 'coordinator' | 'daemon'`
  - `interface CoordinatorMessage { id: number; terminalId: string; sentAt: string; source: CoordinatorMessageSource; text: string }`
  - `messageText(content: string | readonly { type?: string; text?: string }[]): string`
  - `append(db, { terminalId, source, text, sentAt? }): number`
  - `listForTerminal(db, terminalId): CoordinatorMessage[]` (oldest first)
  - `listUserMessages(db, terminalId, after: string | null): CoordinatorMessage[]` (`source = 'user'`, `sent_at > after`)
- Produces (`db/ledger.ts`):
  - `type LedgerKind`, `type LedgerStatus`, `type LedgerOrigin`, `interface LedgerItem` (camelCase fields; `options: string[] | null`)
  - `interface CreateLedgerInput { sessionId; kind; text; author; recommendation?; options?; blocks?; mission?; supersedes?; origin?; status?; quote?; quoteMessageId?; quoteAt?; reading?; now? }`
  - `create(db, input): LedgerItem`, `getBySeq(db, sessionId, seq): LedgerItem | null`, `listBySession(db, sessionId): LedgerItem[]`, `listOpenSeqs(db, sessionId): number[]`
  - `interface StatusPatch { status; quote?; quoteMessageId?; quoteAt?; reading?; reason?; now? }`, `updateStatus(db, sessionId, seq, patch): LedgerItem | null`

- [ ] **Step 1: Write the failing tests**

`packages/core/tests/db/ledger.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as ledgerDb from '../../src/db/ledger.js';

const T0 = '2026-10-05T16:00:00.000Z';
const T1 = '2026-10-05T16:51:00.000Z';

describe('005 migration', () => {
  it('creates both tables and records the migration id', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['coordinator_messages', 'ledger_items']));
    expect(db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get('005-coordinator-messages-and-ledger')).toBeTruthy();
  });

  it('reaches an existing database that predates it', () => {
    const db = new Database(':memory:');
    initSchema(db);
    db.exec("DROP TRIGGER ledger_items_text_immutable; DROP TABLE ledger_items; DROP TABLE coordinator_messages; DELETE FROM schema_migrations WHERE id = '005-coordinator-messages-and-ledger'");
    initSchema(db); // the next boot of an old database
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['coordinator_messages', 'ledger_items']));
  });
});

describe('ledger db', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initSchema(db); });

  const add = (sessionId: string, text: string, extra: Partial<ledgerDb.CreateLedgerInput> = {}) =>
    ledgerDb.create(db, { sessionId, kind: 'decide', text, author: 'overseer', now: T0, ...extra });

  it('counts seq per project, starting at 1', () => {
    expect(add('s1', 'a').seq).toBe(1);
    expect(add('s1', 'b').seq).toBe(2);
    expect(add('s2', 'c').seq).toBe(1);
  });

  it('never repeats a seq, whatever happened to earlier items', () => {
    add('s1', 'a');
    ledgerDb.updateStatus(db, 's1', 1, { status: 'withdrawn', reason: 'moot' });
    expect(add('s1', 'b').seq).toBe(2);
  });

  it('stores every field and reads options back as an array', () => {
    const item = add('s1', 'Which store first?', { recommendation: 'A', options: ['A', 'B'], blocks: 'the import agent', mission: 'Stores' });
    expect(item).toMatchObject({
      sessionId: 's1', seq: 1, kind: 'decide', text: 'Which store first?', author: 'overseer',
      recommendation: 'A', options: ['A', 'B'], blocks: 'the import agent', mission: 'Stores',
      status: 'open', quote: null, origin: 'live', supersedes: null, createdAt: T0, updatedAt: T0,
    });
    expect(ledgerDb.getBySeq(db, 's1', 1)).toEqual(item);
    expect(ledgerDb.getBySeq(db, 's1', 2)).toBeNull();
  });

  it('item text never changes (a trigger rejects any update of it)', () => {
    add('s1', 'Merge PR #12.');
    expect(() => db.prepare("UPDATE ledger_items SET text = 'Merge PR #12 and #13.' WHERE seq = 1").run()).toThrow(/never changes/);
    expect(ledgerDb.getBySeq(db, 's1', 1)!.text).toBe('Merge PR #12.');
  });

  it('updateStatus sets the status and the quote fields, keeps the text, and moves updated_at', () => {
    add('s1', 'Which store first?');
    const out = ledgerDb.updateStatus(db, 's1', 1, { status: 'answered', quote: 'A', quoteMessageId: 7, quoteAt: T1, reading: 'only the first store', now: T1 });
    expect(out).toMatchObject({ status: 'answered', quote: 'A', quoteMessageId: 7, quoteAt: T1, reading: 'only the first store', text: 'Which store first?', updatedAt: T1, createdAt: T0 });
  });

  it('a new item that supersedes an OPEN item marks the old one superseded', () => {
    add('s1', 'Set the first store to Draft?');
    const wider = add('s1', 'Also set the second store to Draft?', { supersedes: 1 });
    expect(wider.supersedes).toBe(1);
    expect(ledgerDb.getBySeq(db, 's1', 1)!.status).toBe('superseded');
  });

  it('a new item that supersedes an ANSWERED item leaves the old answer in place', () => {
    add('s1', 'Set the first store to Draft?');
    ledgerDb.updateStatus(db, 's1', 1, { status: 'answered', quote: 'yes', quoteAt: T1 });
    add('s1', 'Also set the second store to Draft?', { supersedes: 1 });
    expect(ledgerDb.getBySeq(db, 's1', 1)!.status).toBe('answered');
  });

  it('listBySession is in seq order and listOpenSeqs returns only open items', () => {
    add('s1', 'a'); add('s1', 'b'); add('s1', 'c');
    ledgerDb.updateStatus(db, 's1', 2, { status: 'parked', quote: 'later', quoteAt: T1 });
    expect(ledgerDb.listBySession(db, 's1').map((i) => i.seq)).toEqual([1, 2, 3]);
    expect(ledgerDb.listOpenSeqs(db, 's1')).toEqual([1, 3]);
    expect(ledgerDb.listOpenSeqs(db, 's2')).toEqual([]);
  });
});
```

`packages/core/tests/db/coordinator-messages.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as messagesDb from '../../src/db/coordinator-messages.js';

describe('coordinator message log db', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initSchema(db); });

  it('appends rows and lists them oldest first, per terminal', () => {
    messagesDb.append(db, { terminalId: 'c1', source: 'user', text: 'second', sentAt: '2026-10-05T17:02:00.000Z' });
    messagesDb.append(db, { terminalId: 'c1', source: 'daemon', text: 'first', sentAt: '2026-10-05T17:01:00.000Z' });
    messagesDb.append(db, { terminalId: 'c2', source: 'user', text: 'other overseer', sentAt: '2026-10-05T17:00:00.000Z' });
    expect(messagesDb.listForTerminal(db, 'c1').map((m) => [m.text, m.source])).toEqual([['first', 'daemon'], ['second', 'user']]);
  });

  it('stores all four source values', () => {
    for (const source of ['user', 'canned', 'coordinator', 'daemon'] as const) {
      messagesDb.append(db, { terminalId: 'c1', source, text: source });
    }
    expect(messagesDb.listForTerminal(db, 'c1').map((m) => m.source).sort()).toEqual(['canned', 'coordinator', 'daemon', 'user']);
  });

  it('listUserMessages returns only user rows, and only those strictly after the given time', () => {
    messagesDb.append(db, { terminalId: 'c1', source: 'user', text: 'before', sentAt: '2026-10-05T17:00:00.000Z' });
    messagesDb.append(db, { terminalId: 'c1', source: 'user', text: 'at', sentAt: '2026-10-05T17:01:00.000Z' });
    messagesDb.append(db, { terminalId: 'c1', source: 'canned', text: 'card', sentAt: '2026-10-05T17:02:00.000Z' });
    messagesDb.append(db, { terminalId: 'c1', source: 'user', text: 'after', sentAt: '2026-10-05T17:03:00.000Z' });
    expect(messagesDb.listUserMessages(db, 'c1', null).map((m) => m.text)).toEqual(['before', 'at', 'after']);
    expect(messagesDb.listUserMessages(db, 'c1', '2026-10-05T17:01:00.000Z').map((m) => m.text)).toEqual(['after']);
  });

  it('messageText keeps a string, joins text blocks, and turns an image into [image]', () => {
    expect(messagesDb.messageText('hello')).toBe('hello');
    expect(messagesDb.messageText([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } } as any,
      { type: 'text', text: 'caption' },
      { type: 'text', text: 'line two' },
    ])).toBe('[image]\ncaption\nline two');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run tests/db/ledger.test.ts tests/db/coordinator-messages.test.ts`
Expected: FAIL. Both files report `Failed to load url ../../src/db/ledger.js` (or `coordinator-messages.js`) — `Does the file exist?`

- [ ] **Step 3: Write the implementation**

In `packages/core/src/db/schema.ts`, replace the last two lines of `initializeSchema` (line 262 and the closing brace):

```ts
  migrate(db, '004-lifecycle-runtime', () => initRuntimeSchema(db));
}
```

with:

```ts
  migrate(db, '004-lifecycle-runtime', () => initRuntimeSchema(db));
  // Overseer structured recap (spec 2026-10-05): the message log and the decision ledger.
  // A migrate() step, not the legacy column list above, so it reaches existing databases too.
  migrate(db, '005-coordinator-messages-and-ledger', () => db.exec(`
    CREATE TABLE IF NOT EXISTS coordinator_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal_id TEXT NOT NULL,
      sent_at     TEXT NOT NULL,
      source      TEXT NOT NULL,
      text        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_coordinator_messages_terminal ON coordinator_messages(terminal_id, sent_at);
    CREATE TABLE IF NOT EXISTS ledger_items (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id       TEXT NOT NULL,
      seq              INTEGER NOT NULL,
      kind             TEXT NOT NULL,
      text             TEXT NOT NULL,
      author           TEXT NOT NULL,
      recommendation   TEXT,
      options          TEXT,
      blocks           TEXT,
      mission          TEXT,
      status           TEXT NOT NULL DEFAULT 'open',
      quote            TEXT,
      quote_message_id INTEGER,
      quote_at         TEXT,
      reading          TEXT,
      reason           TEXT,
      supersedes       INTEGER,
      origin           TEXT NOT NULL DEFAULT 'live',
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      UNIQUE (session_id, seq)
    );
    CREATE TRIGGER IF NOT EXISTS ledger_items_text_immutable
      BEFORE UPDATE OF text ON ledger_items
      WHEN NEW.text IS NOT OLD.text
      BEGIN SELECT RAISE(ABORT, 'ledger item text never changes'); END;
  `));
}
```

Create `packages/core/src/db/coordinator-messages.ts`:

```ts
import type Database from 'better-sqlite3';

/** Who sent a message that reached an overseer: the human, a card click, another thread, or the daemon. */
export type CoordinatorMessageSource = 'user' | 'canned' | 'coordinator' | 'daemon';

export interface CoordinatorMessage {
  id: number;
  terminalId: string;
  sentAt: string;
  source: CoordinatorMessageSource;
  text: string;
}

interface Row { id: number; terminal_id: string; sent_at: string; source: CoordinatorMessageSource; text: string }

const toMessage = (r: Row): CoordinatorMessage => ({ id: r.id, terminalId: r.terminal_id, sentAt: r.sent_at, source: r.source, text: r.text });

/** A structural content block. Kept local so this storage module never imports the structured manager. */
type Block = { type?: string; text?: string };

/** The logged text of a send: a string as is; for blocks, the text blocks joined by newlines, each image as "[image]". */
export function messageText(content: string | readonly Block[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => (b?.type === 'text' ? String(b.text ?? '') : b?.type === 'image' ? '[image]' : ''))
    .filter((s) => s !== '')
    .join('\n');
}

/** Append one row. Returns its id. */
export function append(
  db: Database.Database,
  input: { terminalId: string; source: CoordinatorMessageSource; text: string; sentAt?: string },
): number {
  const info = db.prepare('INSERT INTO coordinator_messages (terminal_id, sent_at, source, text) VALUES (?, ?, ?, ?)')
    .run(input.terminalId, input.sentAt ?? new Date().toISOString(), input.source, input.text);
  return Number(info.lastInsertRowid);
}

/** Every logged message for one overseer, oldest first. */
export function listForTerminal(db: Database.Database, terminalId: string): CoordinatorMessage[] {
  return (db.prepare('SELECT * FROM coordinator_messages WHERE terminal_id = ? ORDER BY sent_at ASC, id ASC')
    .all(terminalId) as Row[]).map(toMessage);
}

/** The human's own messages to one overseer, oldest first. With `after`, only those sent strictly after it. */
export function listUserMessages(db: Database.Database, terminalId: string, after: string | null): CoordinatorMessage[] {
  const rows = after === null
    ? db.prepare("SELECT * FROM coordinator_messages WHERE terminal_id = ? AND source = 'user' ORDER BY sent_at ASC, id ASC").all(terminalId)
    : db.prepare("SELECT * FROM coordinator_messages WHERE terminal_id = ? AND source = 'user' AND sent_at > ? ORDER BY sent_at ASC, id ASC").all(terminalId, after);
  return (rows as Row[]).map(toMessage);
}
```

Create `packages/core/src/db/ledger.ts`:

```ts
import type Database from 'better-sqlite3';

export type LedgerKind = 'go' | 'decide' | 'do' | 'statement';
export type LedgerStatus = 'open' | 'answered' | 'parked' | 'withdrawn' | 'superseded';
export type LedgerOrigin = 'live' | 'imported';

interface LedgerRow {
  id: number;
  session_id: string;
  seq: number;
  kind: LedgerKind;
  text: string;
  author: string;
  recommendation: string | null;
  options: string | null;
  blocks: string | null;
  mission: string | null;
  status: LedgerStatus;
  quote: string | null;
  quote_message_id: number | null;
  quote_at: string | null;
  reading: string | null;
  reason: string | null;
  supersedes: number | null;
  origin: LedgerOrigin;
  created_at: string;
  updated_at: string;
}

export interface LedgerItem {
  id: number;
  sessionId: string;
  /** Counts up per project. The user sees it as `N<seq>`. */
  seq: number;
  kind: LedgerKind;
  /** The item as shown to the user. Never changes after creation (a trigger enforces it). */
  text: string;
  author: string;
  recommendation: string | null;
  options: string[] | null;
  blocks: string | null;
  mission: string | null;
  status: LedgerStatus;
  quote: string | null;
  quoteMessageId: number | null;
  quoteAt: string | null;
  reading: string | null;
  reason: string | null;
  supersedes: number | null;
  origin: LedgerOrigin;
  createdAt: string;
  updatedAt: string;
}

function rowToItem(r: LedgerRow): LedgerItem {
  let options: string[] | null = null;
  if (r.options) {
    try {
      const parsed = JSON.parse(r.options);
      if (Array.isArray(parsed)) options = parsed.map(String);
    } catch { /* malformed options read as none */ }
  }
  return {
    id: r.id,
    sessionId: r.session_id,
    seq: r.seq,
    kind: r.kind,
    text: r.text,
    author: r.author,
    recommendation: r.recommendation,
    options,
    blocks: r.blocks,
    mission: r.mission,
    status: r.status,
    quote: r.quote,
    quoteMessageId: r.quote_message_id,
    quoteAt: r.quote_at,
    reading: r.reading,
    reason: r.reason,
    supersedes: r.supersedes,
    origin: r.origin,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CreateLedgerInput {
  sessionId: string;
  kind: LedgerKind;
  text: string;
  author: string;
  recommendation?: string | null;
  options?: string[] | null;
  blocks?: string | null;
  mission?: string | null;
  supersedes?: number | null;
  origin?: LedgerOrigin;
  status?: LedgerStatus;
  quote?: string | null;
  quoteMessageId?: number | null;
  quoteAt?: string | null;
  reading?: string | null;
  /** ISO time for created_at/updated_at. Defaults to now. */
  now?: string;
}

/**
 * Create an item with the next per-project `seq` (MAX + 1 — rows are never deleted, so an ID
 * never repeats). When `supersedes` names an item that is still open, that item becomes
 * `superseded` in the same transaction; an answered or parked item keeps its status.
 */
export function create(db: Database.Database, input: CreateLedgerInput): LedgerItem {
  const now = input.now ?? new Date().toISOString();
  return db.transaction((): LedgerItem => {
    const { next } = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM ledger_items WHERE session_id = ?')
      .get(input.sessionId) as { next: number };
    db.prepare(`INSERT INTO ledger_items
      (session_id, seq, kind, text, author, recommendation, options, blocks, mission, status,
       quote, quote_message_id, quote_at, reading, reason, supersedes, origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`).run(
      input.sessionId, next, input.kind, input.text, input.author,
      input.recommendation ?? null,
      input.options && input.options.length ? JSON.stringify(input.options) : null,
      input.blocks ?? null, input.mission ?? null, input.status ?? 'open',
      input.quote ?? null, input.quoteMessageId ?? null, input.quoteAt ?? null, input.reading ?? null,
      input.supersedes ?? null, input.origin ?? 'live', now, now,
    );
    if (input.supersedes !== undefined && input.supersedes !== null) {
      db.prepare("UPDATE ledger_items SET status = 'superseded', updated_at = ? WHERE session_id = ? AND seq = ? AND status = 'open'")
        .run(now, input.sessionId, input.supersedes);
    }
    return getBySeq(db, input.sessionId, next)!;
  })();
}

export function getBySeq(db: Database.Database, sessionId: string, seq: number): LedgerItem | null {
  const row = db.prepare('SELECT * FROM ledger_items WHERE session_id = ? AND seq = ?').get(sessionId, seq) as LedgerRow | undefined;
  return row ? rowToItem(row) : null;
}

/** Every item of one project, in `seq` order. */
export function listBySession(db: Database.Database, sessionId: string): LedgerItem[] {
  return (db.prepare('SELECT * FROM ledger_items WHERE session_id = ? ORDER BY seq ASC').all(sessionId) as LedgerRow[]).map(rowToItem);
}

/** The `seq` of every open item of one project, ascending. */
export function listOpenSeqs(db: Database.Database, sessionId: string): number[] {
  return (db.prepare("SELECT seq FROM ledger_items WHERE session_id = ? AND status = 'open' ORDER BY seq ASC")
    .all(sessionId) as { seq: number }[]).map((r) => r.seq);
}

export interface StatusPatch {
  status: LedgerStatus;
  quote?: string | null;
  quoteMessageId?: number | null;
  quoteAt?: string | null;
  reading?: string | null;
  reason?: string | null;
  now?: string;
}

/** Change an item's status. Fields left out of the patch keep their stored value. Never touches `text`. */
export function updateStatus(db: Database.Database, sessionId: string, seq: number, patch: StatusPatch): LedgerItem | null {
  db.prepare(`UPDATE ledger_items SET status = ?,
      quote = COALESCE(?, quote), quote_message_id = COALESCE(?, quote_message_id), quote_at = COALESCE(?, quote_at),
      reading = COALESCE(?, reading), reason = COALESCE(?, reason), updated_at = ?
    WHERE session_id = ? AND seq = ?`).run(
    patch.status, patch.quote ?? null, patch.quoteMessageId ?? null, patch.quoteAt ?? null,
    patch.reading ?? null, patch.reason ?? null, patch.now ?? new Date().toISOString(), sessionId, seq,
  );
  return getBySeq(db, sessionId, seq);
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd packages/core && npx vitest run tests/db/ledger.test.ts tests/db/coordinator-messages.test.ts tests/db/`
Expected: PASS (14 new tests, every existing db test still green).

Run: `cd packages/core && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/db/schema.ts packages/core/src/db/coordinator-messages.ts packages/core/src/db/ledger.ts packages/core/tests/db/ledger.test.ts packages/core/tests/db/coordinator-messages.test.ts
git commit -m "$(cat <<'EOF'
feat(core): message log and decision ledger tables (migration 005)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Log every message that reaches an overseer

**Files:**
- Modify: `packages/core/src/sessions/service.ts:13` (imports), `:130` (clock field), `:996-1003` (`sendStructuredMessage`), `:1027-1043` (`sendThreadMessage`)
- Modify: `packages/core/src/routes/terminals.ts:116-133`
- Modify: `packages/web/src/api/client.ts:97-102`, `packages/web/src/components/overseer/store.ts:342`
- Test: `packages/core/tests/sessions/coordinator-message-log.test.ts`, `packages/core/tests/routes/message-canned.test.ts`, `packages/web/src/api/client.test.ts` (append), `packages/web/src/components/overseer/store-canned-ack.test.ts`

**Interfaces:**
- Consumes: `coordinatorMessagesDb.append`, `messageText`, `CoordinatorMessageSource` (Task 1).
- Produces:
  - `SessionService.clock: () => number` (public, defaults to `Date.now`; tests replace it). Task 8 uses it for the interim timer.
  - `SessionService.sendStructuredMessage(terminalId, content, source?, logAs?: CoordinatorMessageSource): void`
  - `SessionService.sendThreadMessage(terminalId, content, source?, logAs?: CoordinatorMessageSource)`
  - Route body flag `canned: true` on `POST /api/terminals/:terminalId/message`.
  - Web: `api.sendStructuredMessage(id, content, opts?: { canned?: boolean })`.

- [ ] **Step 1: Write the failing tests**

`packages/core/tests/sessions/coordinator-message-log.test.ts`:

```ts
// The overseer message log (structured-recap spec, Unit 1): every message that reaches a
// coordinator is logged with its sender, at the one write point all structured sends share.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../../src/db/connection.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as messagesDb from '../../src/db/coordinator-messages.js';
import { SessionService } from '../../src/sessions/service.js';
import type { IStructuredManager } from '../../src/structured/manager.js';

class FakePty extends EventEmitter {
  isAlive() { return false; }
  write() {}
  kill() {}
  spawn() { return 1; }
  setDefaultEnv() {}
}

class FakeStructured extends EventEmitter implements IStructuredManager {
  live = new Set<string>();
  sent: { id: string; content: unknown; source?: string }[] = [];
  setDefaultEnv() {}
  spawn(id: string) { this.live.add(id); return 1; }
  sendMessage(id: string, content: unknown, source?: any) { this.sent.push({ id, content, source }); }
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
  kill(id: string) { this.live.delete(id); }
  killAll() { this.live.clear(); }
}

let dir: string;
let db: Database.Database;
let svc: SessionService;
let structured: FakeStructured;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-msglog-'));
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: dir });
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { transport: 'structured', role: 'coordinator' } });
  terminalsDb.create(db, { id: 'agent', sessionId: 's1', type: 'claude-code', label: 'worker', config: { transport: 'structured', role: 'agent', agentType: 'implementer' } });
  structured = new FakeStructured();
  structured.live.add('coord');
  structured.live.add('agent');
  svc = new SessionService(db, new FakePty() as any, path.join(dir, 'mcp.json'));
  svc.setStructuredManager(structured);
  svc.clock = () => Date.parse('2026-10-05T17:00:00.000Z');
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const log = () => messagesDb.listForTerminal(db, 'coord').map((m) => ({ source: m.source, text: m.text }));

describe('overseer message log', () => {
  it('logs a human send as user, a peer send as coordinator, and an untagged send as daemon', () => {
    svc.sendStructuredMessage('coord', 'hello', 'user');
    svc.sendStructuredMessage('coord', 'from a peer', 'coordinator');
    svc.sendStructuredMessage('coord', '✅ Your agent "worker" just finished a turn.');
    expect(log()).toEqual([
      { source: 'user', text: 'hello' },
      { source: 'coordinator', text: 'from a peer' },
      { source: 'daemon', text: '✅ Your agent "worker" just finished a turn.' },
    ]);
    expect(messagesDb.listForTerminal(db, 'coord')[0].sentAt).toBe('2026-10-05T17:00:00.000Z');
  });

  it('logs a canned card click as canned even though its source is user', () => {
    svc.sendThreadMessage('coord', '“Deploy” — got it.', 'user', 'canned');
    expect(log()).toEqual([{ source: 'canned', text: '“Deploy” — got it.' }]);
    expect(structured.sent[0].source).toBe('user'); // the badge tag is unchanged
  });

  it('joins text blocks and writes an image as [image]', () => {
    svc.sendStructuredMessage('coord', [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
      { type: 'text', text: 'look at this' },
    ], 'user');
    expect(log()).toEqual([{ source: 'user', text: '[image]\nlook at this' }]);
  });

  it('never logs a message to a thread that is not a coordinator', () => {
    svc.sendStructuredMessage('agent', 'do the task', 'coordinator');
    expect(messagesDb.listForTerminal(db, 'agent')).toEqual([]);
  });

  it('a failed log write is reported and does not block the send', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.exec('DROP TABLE coordinator_messages');
    expect(() => svc.sendStructuredMessage('coord', 'still delivered', 'user')).not.toThrow();
    expect(structured.sent.map((s) => s.content)).toEqual(['still delivered']);
    expect(err).toHaveBeenCalled();
  });
});
```

`packages/core/tests/routes/message-canned.test.ts`:

```ts
// POST /api/terminals/:id/message accepts `canned: true` and passes it to the send as the
// overseer-log source 'canned'. Without it, the log source comes from `source` as before.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';

describe('POST /terminals/:id/message — canned marker', () => {
  let app: any;
  let spy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true });
    const svc = app._sessionService;
    spy = vi.spyOn(svc, 'sendThreadMessage').mockReturnValue({ transport: 'structured', droppedNonText: false }) as any;
    vi.spyOn(svc, 'noteUserPrompt').mockImplementation(() => {});
    vi.spyOn(svc, 'noteUserMessageToAgent').mockImplementation(() => {});
  });

  it('passes logAs "canned" when the body says canned: true', async () => {
    await request(app).post('/api/terminals/t1/message').send({ text: 'ack', source: 'user', canned: true }).expect(204);
    expect(spy).toHaveBeenCalledWith('t1', 'ack', 'user', 'canned');
  });

  it('passes no logAs for a normal human send', async () => {
    await request(app).post('/api/terminals/t1/message').send({ text: 'hello', source: 'user' }).expect(204);
    expect(spy).toHaveBeenCalledWith('t1', 'hello', 'user', undefined);
  });
});
```

Append to `packages/web/src/api/client.test.ts`:

```ts

test('sendStructuredMessage keeps the plain human wire byte-identical', async () => {
  (fetch as any).mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) });
  await api.sendStructuredMessage('t1', 'hello');
  expect(fetch).toHaveBeenLastCalledWith('/api/terminals/t1/message', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ text: 'hello', source: 'user' }),
  }));
});

test('sendStructuredMessage adds canned: true only when asked', async () => {
  (fetch as any).mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) });
  await api.sendStructuredMessage('t1', 'got it', { canned: true });
  expect(fetch).toHaveBeenLastCalledWith('/api/terminals/t1/message', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ text: 'got it', source: 'user', canned: true }),
  }));
});
```

`packages/web/src/components/overseer/store-canned-ack.test.ts`:

```ts
// The need-card acknowledgement is fixed text a click sends, not the user's own words. It must
// reach the daemon marked canned, so the overseer message log never stores it as 'user'.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useOverseer } from './store';
import { api } from '../../api/client';
import { CANNED } from './data';

beforeEach(() => {
  vi.restoreAllMocks();
  useOverseer.setState({ coordinatorId: 'coord-a', pendingByTerminal: {}, resolved: [] });
});

describe('needAction — canned acknowledgement', () => {
  it('sends the canned need acknowledgement with the canned marker', () => {
    const spy = vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as unknown as void);
    useOverseer.getState().needAction('agent-1', 'Deploy');
    expect(spy).toHaveBeenCalledWith('coord-a', CANNED.needAck('Deploy'), { canned: true });
    expect(useOverseer.getState().resolved).toContain('agent-1');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run tests/sessions/coordinator-message-log.test.ts tests/routes/message-canned.test.ts`
Expected: FAIL. The log tests fail with `expected [] to deeply equal [ …` (nothing is logged yet). The canned route test fails: `expected "spy" to be called with arguments: [ 't1', 'ack', 'user', 'canned' ]`.

Run: `cd packages/web && npx vitest run src/api/client.test.ts src/components/overseer/store-canned-ack.test.ts`
Expected: FAIL on `adds canned: true only when asked` (body lacks `canned`) and on the store test (called with two arguments). The byte-identical test passes already; it guards the old wire.

- [ ] **Step 3: Write the implementation**

`packages/core/src/sessions/service.ts` — after line 13 (`import * as watchesDb from '../db/watches.js';`) add:

```ts
import * as coordinatorMessagesDb from '../db/coordinator-messages.js';
```

After line 130 (`private toolsAwareness?: () => string | null;`) add:

```ts
  /** The service's clock. Tests replace it to pin times (message log, interim recap timer). */
  clock: () => number = () => Date.now();
```

Replace `sendStructuredMessage` (lines 996-1003) with:

```ts
  sendStructuredMessage(
    terminalId: string,
    content: string | import('../structured/manager.js').ContentBlock[],
    source?: import('../structured/manager.js').MessageSource,
    logAs?: coordinatorMessagesDb.CoordinatorMessageSource,
  ): void {
    // Lazily resume a thread that died on a daemon restart (resumes the same claude
    // conversation when an external_id was captured) before delivering the message.
    const manager = this.structuredManagerForTerminal(terminalId);
    if (!manager?.isAlive(terminalId)) this.ensureStructuredAlive(terminalId);
    if (!manager?.isAlive(terminalId)) throw new Error('no structured session for terminal');
    manager.sendMessage(terminalId, content, source);
    this.logCoordinatorMessage(terminalId, content, logAs ?? (source === 'user' ? 'user' : source === 'coordinator' ? 'coordinator' : 'daemon'));
  }

  /**
   * The overseer message log (structured-recap spec, Unit 1): every message that reaches a
   * coordinator, with who sent it, so a ledger quote can be checked against the human's real
   * words. Only coordinators are logged. Written AFTER manager.sendMessage returns; a failed
   * write is logged and never blocks the send.
   */
  private logCoordinatorMessage(
    terminalId: string,
    content: string | import('../structured/manager.js').ContentBlock[],
    source: coordinatorMessagesDb.CoordinatorMessageSource,
  ): void {
    try {
      const row = terminalsDb.getById(this.db, terminalId);
      if (!row) return;
      let cfg: Record<string, any> = {};
      try { cfg = JSON.parse(row.config || '{}'); } catch { /* default {} */ }
      if (cfg.role !== 'coordinator') return;
      coordinatorMessagesDb.append(this.db, {
        terminalId,
        source,
        text: coordinatorMessagesDb.messageText(content),
        sentAt: new Date(this.clock()).toISOString(),
      });
    } catch (err) {
      console.error(`coordinator message log: write failed for ${terminalId}`, err);
    }
  }
```

In `sendThreadMessage` (line 1027), replace the signature:

```ts
  sendThreadMessage(
    terminalId: string,
    content: string | import('../structured/manager.js').ContentBlock[],
    source?: import('../structured/manager.js').MessageSource,
  ): { transport: 'structured' | 'pty'; droppedNonText: boolean } {
```

with:

```ts
  sendThreadMessage(
    terminalId: string,
    content: string | import('../structured/manager.js').ContentBlock[],
    source?: import('../structured/manager.js').MessageSource,
    logAs?: coordinatorMessagesDb.CoordinatorMessageSource,
  ): { transport: 'structured' | 'pty'; droppedNonText: boolean } {
```

and replace line 1042:

```ts
      this.sendStructuredMessage(terminalId, content, source);
```

with:

```ts
      this.sendStructuredMessage(terminalId, content, source, logAs);
```

`packages/core/src/routes/terminals.ts` — replace lines 124-125:

```ts
  router.post('/terminals/:terminalId/message', (req, res) => {
    const { text, content, source } = req.body ?? {};
```

with:

```ts
  // Optional `canned: true` marks fixed text that a card click sent (the need-card
  // acknowledgement). It changes only the overseer message log ('canned', never 'user'),
  // so a ledger quote can never match it; `source` and the "via Dispatch" badge are unchanged.
  router.post('/terminals/:terminalId/message', (req, res) => {
    const { text, content, source, canned } = req.body ?? {};
```

and replace line 133:

```ts
      const sent = sessionService.sendThreadMessage(req.params.terminalId, payload, source);
```

with:

```ts
      const sent = sessionService.sendThreadMessage(req.params.terminalId, payload, source, canned === true ? 'canned' : undefined);
```

`packages/web/src/api/client.ts` — replace lines 101-102:

```ts
  sendStructuredMessage: (id: string, content: string | ContentBlock[]) =>
    req<void>(`/api/terminals/${id}/message`, { method: 'POST', body: body({ ...(typeof content === 'string' ? { text: content } : { content }), source: 'user' }) }),
```

with:

```ts
  // `canned: true` marks fixed text a card click sent (the need-card acknowledgement): the
  // daemon logs it as 'canned', so it can never count as the user's own words in the ledger.
  sendStructuredMessage: (id: string, content: string | ContentBlock[], opts?: { canned?: boolean }) =>
    req<void>(`/api/terminals/${id}/message`, { method: 'POST', body: body({ ...(typeof content === 'string' ? { text: content } : { content }), source: 'user', ...(opts?.canned ? { canned: true } : {}) }) }),
```

`packages/web/src/components/overseer/store.ts` — replace line 342:

```ts
    if (coordinatorId) api.sendStructuredMessage(coordinatorId, CANNED.needAck(label)).catch(() => {});
```

with:

```ts
    if (coordinatorId) api.sendStructuredMessage(coordinatorId, CANNED.needAck(label), { canned: true }).catch(() => {});
```

- [ ] **Step 4: Run the tests and the typechecks**

Run: `cd packages/core && npx vitest run tests/sessions/coordinator-message-log.test.ts tests/routes/message-canned.test.ts src/sessions/send-thread-message.test.ts tests/routes/terminals.test.ts`
Expected: PASS.

Run: `cd packages/web && npx vitest run src/api/client.test.ts src/components/overseer/store-canned-ack.test.ts src/components/overseer/store.test.ts`
Expected: PASS (the composer test still sees exactly two arguments).

Run: `cd packages/core && npx tsc --noEmit -p .` and `cd packages/web && npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sessions/service.ts packages/core/src/routes/terminals.ts packages/core/tests/sessions/coordinator-message-log.test.ts packages/core/tests/routes/message-canned.test.ts packages/web/src/api/client.ts packages/web/src/api/client.test.ts packages/web/src/components/overseer/store.ts packages/web/src/components/overseer/store-canned-ack.test.ts
git commit -m "$(cat <<'EOF'
feat: log every message that reaches an overseer, with its sender

The canned need-card acknowledgement is logged as canned, never as user.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Pure quote matcher

**Files:**
- Create: `packages/core/src/overseer/ledger-quote.ts`
- Test: `packages/core/tests/overseer/ledger-quote.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `OK_ONLY_ERROR: string`
  - `interface QuoteCandidate { id: number; sentAt: string; source: string; text: string }` (a `CoordinatorMessage` fits it)
  - `type QuoteMatch = { ok: true; messageId: number; sentAt: string; quote: string } | { ok: false; reason: 'not_found' | 'ok_only' }`
  - `normalizeForMatch(s: string): string`
  - `findQuote(quote: string, messages: readonly QuoteCandidate[], opts: { after: string | null }): QuoteMatch`

- [ ] **Step 1: Write the failing test**

`packages/core/tests/overseer/ledger-quote.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { findQuote, normalizeForMatch, OK_ONLY_ERROR, type QuoteCandidate } from '../../src/overseer/ledger-quote.js';

let nextId = 1;
const msg = (text: string, minute: number, source = 'user'): QuoteCandidate =>
  ({ id: nextId++, text, source, sentAt: `2026-10-05T17:${String(minute).padStart(2, '0')}:00.000Z` });

describe('normalizeForMatch', () => {
  it('lower-cases, collapses white space runs, and trims', () => {
    expect(normalizeForMatch('  A,  but\n\tONLY  ')).toBe('a, but only');
  });
});

describe('findQuote', () => {
  it('ignores case and runs of white space, and stores the user\'s own text', () => {
    const r = findQuote('a, BUT only   for the first store', [msg('N8: A, but only for the first store', 1)], { after: null });
    expect(r).toEqual({ ok: true, messageId: expect.any(Number), sentAt: '2026-10-05T17:01:00.000Z', quote: 'A, but only for the first store' });
  });

  it('counts only messages strictly after the given time', () => {
    const early = msg('use library A', 1);
    expect(findQuote('use library A', [early], { after: '2026-10-05T17:01:00.000Z' })).toEqual({ ok: false, reason: 'not_found' });
    expect(findQuote('use library A', [early], { after: '2026-10-05T17:00:59.000Z' }).ok).toBe(true);
  });

  it('never matches canned, coordinator or daemon messages — including a Direct message relay', () => {
    const r = findQuote('merge it', [
      msg('“merge it” — got it. I\'ll pass it down and close this out.', 1, 'canned'),
      msg('merge it', 2, 'coordinator'),
      msg('💬 The user just sent your agent "X" [agentId a1] a message directly, not through you: "merge it".', 3, 'daemon'),
    ], { after: null });
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });

  it('picks the earliest matching message', () => {
    const first = msg('ship it', 2);
    const second = msg('ship it', 3);
    const r = findQuote('ship it', [second, first], { after: null });
    expect(r.ok && r.messageId).toBe(first.id);
  });

  it('"ok", "OK.", "okay, " and "k" alone fail as ok_only', () => {
    for (const text of ['ok', 'OK.', 'okay, ', 'k']) {
      expect(findQuote(text, [msg(text, 1)], { after: null }), text).toEqual({ ok: false, reason: 'ok_only' });
    }
    expect(OK_ONLY_ERROR).toBe("An 'ok' at the start of a message is not an answer. Ask the user.");
  });

  it('"ok, merge N12" stores "merge N12"', () => {
    const r = findQuote('ok, merge N12', [msg('ok, merge N12', 1)], { after: null });
    expect(r.ok && r.quote).toBe('merge N12');
  });

  it('removes the ok-word only when the match starts at the beginning of the message', () => {
    const r = findQuote('ok', [msg('fine, ok', 1)], { after: null });
    expect(r.ok && r.quote).toBe('ok'); // an "ok" in the middle of a message is not removed
  });

  it('a word that merely starts with k is not an ok-word', () => {
    const r = findQuote('kick off the import', [msg('kick off the import', 1)], { after: null });
    expect(r.ok && r.quote).toBe('kick off the import');
  });

  it('an empty quote never matches', () => {
    expect(findQuote('   ', [msg('anything', 1)], { after: null })).toEqual({ ok: false, reason: 'not_found' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx vitest run tests/overseer/ledger-quote.test.ts`
Expected: FAIL — `Failed to load url ../../src/overseer/ledger-quote.js`.

- [ ] **Step 3: Write the implementation**

`packages/core/src/overseer/ledger-quote.ts`:

```ts
/**
 * The ledger's quote check (structured-recap spec, Unit 2 rules 2 and 6). Pure: it takes the
 * overseer's logged messages and decides whether the user really wrote the quoted words.
 *
 * - The match ignores case and runs of white space.
 * - Only `user` messages count; `canned`, `coordinator` and `daemon` messages never match.
 * - With `after`, only messages sent strictly after that time count.
 * - The earliest matching message wins.
 * - A leading ok-word (ok, okay, k, kk — any case, then any punctuation and spaces) is removed
 *   from the quote when the match starts at the beginning of the message. If nothing remains,
 *   the check fails as `ok_only`. An "ok" in the middle of a message is never removed.
 * - The stored quote is the user's own text for the matched words (their case, their spacing).
 */

export const OK_ONLY_ERROR = "An 'ok' at the start of a message is not an answer. Ask the user.";

export interface QuoteCandidate {
  id: number;
  sentAt: string;
  source: string;
  text: string;
}

export type QuoteMatch =
  | { ok: true; messageId: number; sentAt: string; quote: string }
  | { ok: false; reason: 'not_found' | 'ok_only' };

const OK_PREFIX = /^(?:okay|ok|kk|k)(?![\p{L}\p{N}])[\s\p{P}]*/u;

/** Lower-cased text with each run of white space collapsed to one space, plus, for every
 *  output character, the index of the original character it came from. */
function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let inSpace = false;
  for (let i = 0; i < s.length;) {
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    if (/\s/u.test(ch)) {
      if (!inSpace) { norm += ' '; map.push(i); inSpace = true; }
    } else {
      inSpace = false;
      const lower = ch.toLowerCase();
      for (let k = 0; k < lower.length; k++) { norm += lower[k]; map.push(i); }
    }
    i += ch.length;
  }
  return { norm, map };
}

/** The form both sides are compared in: lower case, white space runs collapsed, trimmed. */
export function normalizeForMatch(s: string): string {
  return normalizeWithMap(s).norm.trim();
}

export function findQuote(quote: string, messages: readonly QuoteCandidate[], opts: { after: string | null }): QuoteMatch {
  const needle = normalizeForMatch(quote);
  if (!needle) return { ok: false, reason: 'not_found' };
  const candidates = messages
    .filter((m) => m.source === 'user' && (opts.after === null || m.sentAt > opts.after))
    .sort((a, b) => (a.sentAt === b.sentAt ? a.id - b.id : a.sentAt < b.sentAt ? -1 : 1));
  let sawOkOnly = false;
  for (const msg of candidates) {
    const { norm, map } = normalizeWithMap(msg.text);
    const lead = norm.startsWith(' ') ? 1 : 0; // leading white space does not move "the start"
    for (let at = norm.indexOf(needle); at !== -1; at = norm.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      const okWord = at === lead ? needle.match(OK_PREFIX) : null;
      const start = okWord ? at + okWord[0].length : at;
      if (start >= end) { sawOkOnly = true; continue; }
      const last = map[end - 1];
      const words = msg.text.slice(map[start], last + String.fromCodePoint(msg.text.codePointAt(last)!).length).trim();
      if (!words) { sawOkOnly = true; continue; }
      return { ok: true, messageId: msg.id, sentAt: msg.sentAt, quote: words };
    }
  }
  return { ok: false, reason: sawOkOnly ? 'ok_only' : 'not_found' };
}
```

- [ ] **Step 4: Run the test and the typecheck**

Run: `cd packages/core && npx vitest run tests/overseer/ledger-quote.test.ts`
Expected: PASS (10 tests).

Run: `cd packages/core && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/overseer/ledger-quote.ts packages/core/tests/overseer/ledger-quote.test.ts
git commit -m "$(cat <<'EOF'
feat(core): ledger quote matcher with the leading-ok rule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Pure ledger renderer

**Files:**
- Create: `packages/core/src/overseer/ledger-render.ts`
- Test: `packages/core/tests/overseer/ledger-render.test.ts`

**Interfaces:**
- Consumes: `LedgerItem`, `LedgerKind` (Task 1).
- Produces:
  - `KIND_LABEL: Record<LedgerKind, string>`, `HANDOFF_HEADER = 'Owner decisions (verbatim, from the ledger):'`
  - `interface RenderContext { now: number; timeZone?: string; lookup?: (seq: number) => LedgerItem | null }`
  - `formatStamp(iso: string, timeZone?: string): string` (`Mon 16:51`), `formatAge(ms: number): string`
  - `isUnchecked(item: LedgerItem): boolean`
  - `renderItem(item: LedgerItem, ctx: RenderContext): string`
  - `renderLedgerSections(items: LedgerItem[], opts: { now: number; lastRecapAt: string | null; timeZone?: string }): string`
  - `renderHandoffBlock(items: LedgerItem[], ctx: RenderContext): string`

- [ ] **Step 1: Write the failing test**

`packages/core/tests/overseer/ledger-render.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { LedgerItem } from '../../src/db/ledger.js';
import { formatAge, formatStamp, renderItem, renderLedgerSections, renderHandoffBlock } from '../../src/overseer/ledger-render.js';

const NOW = Date.parse('2026-10-05T18:51:00.000Z'); // a Monday
const AT = '2026-10-05T16:51:00.000Z';
const ctx = { now: NOW, timeZone: 'UTC' };

function item(over: Partial<LedgerItem>): LedgerItem {
  return {
    id: 1, sessionId: 's1', seq: 1, kind: 'decide', text: 'Which store goes first?', author: 'overseer',
    recommendation: null, options: null, blocks: null, mission: null, status: 'open',
    quote: null, quoteMessageId: null, quoteAt: null, reading: null, reason: null, supersedes: null,
    origin: 'live', createdAt: '2026-10-05T16:00:00.000Z', updatedAt: '2026-10-05T16:00:00.000Z',
    ...over,
  };
}

describe('formatStamp / formatAge', () => {
  it('formats a stamp as weekday plus 24-hour time', () => {
    expect(formatStamp(AT, 'UTC')).toBe('Mon 16:51');
    expect(formatStamp('2026-10-05T00:05:00.000Z', 'UTC')).toBe('Mon 00:05');
  });
  it('formats ages in minutes, hours, then days', () => {
    expect(formatAge(42 * 60_000)).toBe('42m');
    expect(formatAge(5 * 3_600_000)).toBe('5h');
    expect(formatAge(47 * 3_600_000)).toBe('47h');
    expect(formatAge(3 * 86_400_000)).toBe('3d');
  });
});

describe('renderItem — the labels', () => {
  it('an open item: kind, text, age, details, and "Proposed by …, not approved"', () => {
    expect(renderItem(item({ recommendation: 'the first store', options: ['A', 'B'], blocks: 'the import agent' }), ctx)).toBe(
      'N1 [Decide] Which store goes first? (open 2h)\n' +
      '  Recommendation: the first store\n' +
      '  Options: A | B\n' +
      '  Blocks: the import agent\n' +
      '  Proposed by overseer, not approved',
    );
  });

  it('an answered go item: "You approved: <text> → <quote> (Mon 16:51)" plus the reading line', () => {
    expect(renderItem(item({ seq: 12, kind: 'go', text: 'Merge PR #12.', status: 'answered', quote: 'merge N12', quoteAt: AT, reading: 'merge only, no release' }), ctx)).toBe(
      'N12 [Go] Merge PR #12.\n' +
      '  You approved: "Merge PR #12." → "merge N12" (Mon 16:51)\n' +
      '  I read this as: merge only, no release',
    );
  });

  it('a statement: "You said: <quote> (Mon 16:51)"', () => {
    expect(renderItem(item({ seq: 3, kind: 'statement', text: 'never touch the archive table', author: 'you', status: 'answered', quote: 'never touch the archive table', quoteAt: AT }), ctx))
      .toBe('N3 You said: "never touch the archive table" (Mon 16:51)');
  });

  it('an imported item without a checked quote says "Imported, not checked"', () => {
    expect(renderItem(item({ origin: 'imported' }), ctx)).toBe('N1 [Decide] Which store goes first? (open 2h)\n  Imported, not checked');
    expect(renderItem(item({ origin: 'imported', status: 'answered' }), ctx)).toBe('N1 [Decide] Which store goes first?\n  Imported, not checked');
    expect(renderItem(item({ origin: 'imported', kind: 'statement', status: 'answered', text: 'keep prices' }), ctx)).toBe('N1 [Statement] keep prices\n  Imported, not checked');
  });

  it('withdrawn, parked, and a superseding item that shows the original question', () => {
    expect(renderItem(item({ status: 'withdrawn', reason: 'the agent found a built-in option' }), ctx))
      .toBe('N1 [Decide] Which store goes first?\n  Withdrawn by overseer: the agent found a built-in option');
    expect(renderItem(item({ status: 'parked', quote: 'later', quoteAt: AT }), ctx))
      .toBe('N1 [Decide] Which store goes first?\n  Parked by you: "later" (Mon 16:51)');
    const original = item({ seq: 3, text: 'Set the first store to Draft?', status: 'superseded' });
    const wider = item({ seq: 4, text: 'Also set the second store to Draft?', supersedes: 3 });
    expect(renderItem(wider, { ...ctx, lookup: (s) => (s === 3 ? original : null) })).toBe(
      'N4 [Decide] Also set the second store to Draft? (open 2h)\n' +
      '  Original question (N3): "Set the first store to Draft?"\n' +
      '  Proposed by overseer, not approved',
    );
  });
});

describe('renderLedgerSections', () => {
  const items = [
    item({ seq: 1, kind: 'go', text: 'Merge PR #12.' }),
    item({ seq: 2, kind: 'do', text: 'Check the banner on staging.' }),
    item({ seq: 3, kind: 'decide', text: 'Use library A?', status: 'answered', quote: 'A', quoteAt: AT, updatedAt: AT }),
    item({ seq: 4, kind: 'decide', text: 'Rename the CLI?', status: 'parked', quote: 'later', quoteAt: AT, updatedAt: AT }),
    item({ seq: 5, kind: 'decide', text: 'Old question?', status: 'answered', quote: 'yes', quoteAt: '2026-10-04T10:00:00.000Z', updatedAt: '2026-10-04T10:00:00.000Z' }),
  ];

  it('renders the four sections in order, with decided items only since the last recap', () => {
    expect(renderLedgerSections(items, { now: NOW, lastRecapAt: '2026-10-05T12:00:00.000Z', timeZone: 'UTC' })).toBe(
      'Needs you now:\n' +
      '- N1 [Go] Merge PR #12. (open 2h)\n' +
      '  Proposed by overseer, not approved\n' +
      '\n' +
      'Your tests and actions:\n' +
      '- N2 [Do] Check the banner on staging. (open 2h)\n' +
      '  Proposed by overseer, not approved\n' +
      '\n' +
      'Decided since the last recap:\n' +
      '- N3 [Decide] Use library A?\n' +
      '  You approved: "Use library A?" → "A" (Mon 16:51)\n' +
      '\n' +
      'Parked:\n' +
      '- N4 [Decide] Rename the CLI?\n' +
      '  Parked by you: "later" (Mon 16:51)',
    );
  });

  it('shows "- none" for an empty section and every decision when there was no recap yet', () => {
    const out = renderLedgerSections([items[4]], { now: NOW, lastRecapAt: null, timeZone: 'UTC' });
    expect(out).toContain('Needs you now:\n- none');
    expect(out).toContain('Decided since the last recap:\n- N5 [Decide] Old question?');
  });
});

describe('renderHandoffBlock', () => {
  it('starts with the fixed header and lists each item verbatim', () => {
    expect(renderHandoffBlock([item({ seq: 3, kind: 'decide', text: 'Use library A?', status: 'answered', quote: 'A', quoteAt: AT })], ctx)).toBe(
      'Owner decisions (verbatim, from the ledger):\n' +
      '- N3 [Decide] Use library A?\n' +
      '  You approved: "Use library A?" → "A" (Mon 16:51)',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx vitest run tests/overseer/ledger-render.test.ts`
Expected: FAIL — `Failed to load url ../../src/overseer/ledger-render.js`.

- [ ] **Step 3: Write the implementation**

`packages/core/src/overseer/ledger-render.ts`:

```ts
/**
 * Renders ledger items as the lines an overseer pastes to the user (structured-recap spec,
 * Unit 2 labels and Unit 3 ledger_list). Pure: the caller passes the time and the items.
 *
 * Labels (exact):
 *   You said: "<quote>" (Mon 16:51)                    — a statement
 *   You approved: "<text>" → "<quote>" (Mon 16:51)     — answered on go/decide
 *   Proposed by <author>, not approved                 — open
 *   I read this as: …                                  — its own line, only when reading is set
 *   Imported, not checked                              — imported, no checked quote yet
 *   Withdrawn by overseer: <reason>                    — withdrawn
 */
import type { LedgerItem, LedgerKind } from '../db/ledger.js';

export const KIND_LABEL: Record<LedgerKind, string> = { go: 'Go', decide: 'Decide', do: 'Do', statement: 'Statement' };

export const HANDOFF_HEADER = 'Owner decisions (verbatim, from the ledger):';

export interface RenderContext {
  /** "Now" in epoch ms, for the age of open items. */
  now: number;
  /** IANA time zone for the "(Mon 16:51)" stamps. Defaults to the daemon's local zone. */
  timeZone?: string;
  /** Finds another item of the same project, for the "Original question" line. */
  lookup?: (seq: number) => LedgerItem | null;
}

/** "Mon 16:51": short weekday plus 24-hour time. */
export function formatStamp(iso: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone,
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('hour')}:${part('minute')}`;
}

/** "42m" under an hour, "5h" under two days, else "3d". */
export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Imported and never confirmed: no checked quote yet. */
export function isUnchecked(item: LedgerItem): boolean {
  return item.origin === 'imported' && item.quote === null;
}

function attribution(item: LedgerItem, stamp: string): string[] {
  if (isUnchecked(item)) return ['  Imported, not checked'];
  switch (item.status) {
    case 'open':
      return [`  Proposed by ${item.author}, not approved`];
    case 'answered':
      if (item.kind === 'go' || item.kind === 'decide') return [`  You approved: "${item.text}" → "${item.quote}"${stamp}`];
      if (item.kind === 'do') return [`  You said: "${item.quote}"${stamp}`];
      return []; // a statement carries its quote on the first line
    case 'parked':
      return [`  Parked by you: "${item.quote}"${stamp}`];
    case 'withdrawn':
      return [`  Withdrawn by overseer: ${item.reason ?? ''}`];
    case 'superseded':
      return ['  Superseded, not approved'];
  }
}

/** One item as a block: the first line, then two-space-indented detail lines. */
export function renderItem(item: LedgerItem, ctx: RenderContext): string {
  const id = `N${item.seq}`;
  const stamp = item.quoteAt ? ` (${formatStamp(item.quoteAt, ctx.timeZone)})` : '';
  const lines: string[] = [];
  if (item.kind === 'statement' && !isUnchecked(item)) {
    lines.push(`${id} You said: "${item.quote}"${stamp}`);
  } else {
    const age = item.status === 'open' ? ` (open ${formatAge(ctx.now - Date.parse(item.createdAt))})` : '';
    lines.push(`${id} [${KIND_LABEL[item.kind]}] ${item.text}${age}`);
  }
  if (item.supersedes !== null) {
    const original = ctx.lookup?.(item.supersedes);
    if (original) lines.push(`  Original question (N${original.seq}): "${original.text}"`);
  }
  if (item.recommendation) lines.push(`  Recommendation: ${item.recommendation}`);
  if (item.options && item.options.length) lines.push(`  Options: ${item.options.join(' | ')}`);
  if (item.blocks) lines.push(`  Blocks: ${item.blocks}`);
  lines.push(...attribution(item, stamp));
  if (item.reading) lines.push(`  I read this as: ${item.reading}`);
  return lines.join('\n');
}

function section(title: string, items: LedgerItem[], ctx: RenderContext): string {
  const body = items.length ? items.map((i) => `- ${renderItem(i, ctx)}`).join('\n') : '- none';
  return `${title}:\n${body}`;
}

/**
 * The ledger part of a recap, in this order: Needs you now (open go/decide), Your tests and
 * actions (open do), Decided since the last recap (answered or withdrawn after `lastRecapAt`;
 * everything when null), Parked.
 */
export function renderLedgerSections(
  items: LedgerItem[],
  opts: { now: number; lastRecapAt: string | null; timeZone?: string },
): string {
  const bySeq = new Map(items.map((i) => [i.seq, i] as const));
  const ctx: RenderContext = { now: opts.now, timeZone: opts.timeZone, lookup: (seq) => bySeq.get(seq) ?? null };
  const since = (i: LedgerItem) => opts.lastRecapAt === null || i.updatedAt > opts.lastRecapAt;
  return [
    section('Needs you now', items.filter((i) => i.status === 'open' && (i.kind === 'go' || i.kind === 'decide')), ctx),
    section('Your tests and actions', items.filter((i) => i.status === 'open' && i.kind === 'do'), ctx),
    section('Decided since the last recap', items.filter((i) => (i.status === 'answered' || i.status === 'withdrawn') && since(i)), ctx),
    section('Parked', items.filter((i) => i.status === 'parked'), ctx),
  ].join('\n\n');
}

/** The block the daemon appends to an agent hand-off for `ledgerIds`. */
export function renderHandoffBlock(items: LedgerItem[], ctx: RenderContext): string {
  return [HANDOFF_HEADER, ...items.map((i) => `- ${renderItem(i, ctx)}`)].join('\n');
}
```

- [ ] **Step 4: Run the test and the typecheck**

Run: `cd packages/core && npx vitest run tests/overseer/ledger-render.test.ts`
Expected: PASS (10 tests).

Run: `cd packages/core && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/overseer/ledger-render.ts packages/core/tests/overseer/ledger-render.test.ts
git commit -m "$(cat <<'EOF'
feat(core): ledger renderer — labels, ages, recap sections, hand-off block

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Ledger service and REST routes (overseer only)

**Files:**
- Create: `packages/core/src/overseer/ledger-service.ts`
- Create: `packages/core/src/routes/ledger.ts`
- Modify: `packages/core/src/server.ts:73` (imports), `:347` (createApp mount), `:643` (startServer mount)
- Test: `packages/core/tests/overseer/ledger-service.test.ts`, `packages/core/tests/routes/ledger.test.ts`

**Interfaces:**
- Consumes: Task 1 (`ledgerDb.*`, `coordinatorMessagesDb.listUserMessages`), Task 3 (`findQuote`, `OK_ONLY_ERROR`), Task 4 (`renderItem`, `renderLedgerSections`, `renderHandoffBlock`, `isUnchecked`, `RenderContext`); `terminalsDb.getById`, `terminalsDb.updateConfig` (`packages/core/src/db/terminals.ts:100, 169`).
- Produces:
  - Constants: `NOT_OVERSEER_ERROR`, `QUOTE_NOT_FOUND_STATEMENT_ERROR`, `quoteNotFoundAfterError(seq: number): string`, `LAST_RECAP_KEY = 'lastRecapAt'`, `INTERIM_DUE_KEY = 'interimDueAt'` (Task 8 imports `INTERIM_DUE_KEY`).
  - `class LedgerError extends Error { status: number; body: Record<string, unknown> }`
  - `parseLedgerId(raw: unknown): number | null`
  - `class LedgerService(db, opts?: { clock?: () => number; timeZone?: string })` with:
    - `assertOverseer(sessionId, caller): TerminalRow`
    - `add(sessionId, caller, input): { id: string; line: string }`
    - `resolve(sessionId, caller, input: { id, status, quote?, reading?, reason? }): { id: string; status: string; line: string }` (Task 12 extends it)
    - `note(sessionId, caller, input): { id: string; line: string }`
    - `list(sessionId, caller, opts?: { forRecap?: boolean }): { text: string; openIds: string[] }`
    - `importItems(sessionId, caller, items): { ids: string[] }`
    - `handoff(sessionId, caller, ids): { block: string }`
  - Routes (all POST, body carries `caller`): `/api/sessions/:sessionId/ledger` (201), `/ledger/list` (200), `/ledger/note` (201), `/ledger/import` (201), `/ledger/handoff` (200), `/ledger/:itemId/resolve` (200). Errors: `{ error, ...body }` with the `LedgerError` status.

- [ ] **Step 1: Write the failing tests**

`packages/core/tests/overseer/ledger-service.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as ledgerDb from '../../src/db/ledger.js';
import * as messagesDb from '../../src/db/coordinator-messages.js';
import { LedgerService, LedgerError, NOT_OVERSEER_ERROR, parseLedgerId, quoteNotFoundAfterError, QUOTE_NOT_FOUND_STATEMENT_ERROR } from '../../src/overseer/ledger-service.js';
import { OK_ONLY_ERROR } from '../../src/overseer/ledger-quote.js';

const T0 = Date.parse('2026-10-05T16:00:00.000Z');
const min = (n: number) => new Date(T0 + n * 60_000).toISOString();

let db: Database.Database;
let now: number;
let ledger: LedgerService;

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  sessionsDb.create(db, { id: 's2', provider: 'claude-code', name: 'q', workingDir: '/tmp' });
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator', transport: 'structured' } });
  terminalsDb.create(db, { id: 'agent', sessionId: 's1', type: 'claude-code', label: 'worker', config: { role: 'agent' } });
  terminalsDb.create(db, { id: 'plain', sessionId: 's1', type: 'claude-code', label: 'plain', config: {} });
  terminalsDb.create(db, { id: 'coord2', sessionId: 's2', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
  now = T0;
  ledger = new LedgerService(db, { clock: () => now, timeZone: 'UTC' });
});

const userSays = (text: string, minute: number, source: messagesDb.CoordinatorMessageSource = 'user') =>
  messagesDb.append(db, { terminalId: 'coord', source, text, sentAt: min(minute) });

function expectLedgerError(fn: () => unknown, status: number, message?: string): LedgerError {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(LedgerError);
    expect((e as LedgerError).status).toBe(status);
    if (message !== undefined) expect((e as LedgerError).message).toBe(message);
    return e as LedgerError;
  }
  throw new Error('expected a LedgerError');
}

describe('parseLedgerId', () => {
  it('accepts N12, n12, 12 and 12 as a number', () => {
    expect(parseLedgerId('N12')).toBe(12);
    expect(parseLedgerId('n12')).toBe(12);
    expect(parseLedgerId(' 12 ')).toBe(12);
    expect(parseLedgerId(12)).toBe(12);
    expect(parseLedgerId('N0')).toBeNull();
    expect(parseLedgerId('twelve')).toBeNull();
  });
});

describe('overseer-only check', () => {
  it('rejects an agent, a plain thread, another project\'s overseer, an archived overseer, and no caller', () => {
    terminalsDb.create(db, { id: 'old', sessionId: 's1', type: 'claude-code', label: 'old', config: { role: 'coordinator' } });
    terminalsDb.archive(db, 'old');
    for (const caller of ['agent', 'plain', 'coord2', 'old', undefined, 'nope']) {
      expectLedgerError(() => ledger.add('s1', caller, { kind: 'go', text: 'Merge PR #12.' }), 403, NOT_OVERSEER_ERROR);
    }
    expect(ledgerDb.listBySession(db, 's1')).toEqual([]);
  });
});

describe('add', () => {
  it('creates an open item and returns its ID and rendered line', () => {
    expect(ledger.add('s1', 'coord', { kind: 'decide', text: 'Which store goes first?', options: ['A', 'B'] })).toEqual({
      id: 'N1',
      line: 'N1 [Decide] Which store goes first? (open 0m)\n  Options: A | B\n  Proposed by overseer, not approved',
    });
  });

  it('rejects a bad kind, missing text, and an unknown supersedes ID', () => {
    expectLedgerError(() => ledger.add('s1', 'coord', { kind: 'statement', text: 'x' }), 400);
    expectLedgerError(() => ledger.add('s1', 'coord', { kind: 'go', text: '  ' }), 400);
    expectLedgerError(() => ledger.add('s1', 'coord', { kind: 'go', text: 'x', supersedes: 'N9' }), 404, 'Unknown ledger item: N9');
  });
});

describe('resolve', () => {
  beforeEach(() => { ledger.add('s1', 'coord', { kind: 'decide', text: 'Which store goes first?' }); });

  it('answered: finds the quote in a later user message and stores the user\'s words and message link', () => {
    const msgId = userSays('N1: A, but only for the first store', 5);
    now = T0 + 6 * 60_000;
    const out = ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'a, but only for the FIRST store' });
    expect(out.line).toContain('You approved: "Which store goes first?" → "A, but only for the first store" (Mon 16:05)');
    expect(ledgerDb.getBySeq(db, 's1', 1)).toMatchObject({ status: 'answered', quote: 'A, but only for the first store', quoteMessageId: msgId, quoteAt: min(5) });
  });

  it('a quote that is not in the user\'s messages fails with the fixed text and changes nothing', () => {
    userSays('B', 5);
    userSays('A', 6, 'canned');
    userSays('A', 7, 'daemon');
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'A' }), 422,
      "Quote not found in the user's messages to you after N1 was created. Do not record it. Ask the user.");
    expect(quoteNotFoundAfterError(1)).toBe("Quote not found in the user's messages to you after N1 was created. Do not record it. Ask the user.");
    expect(ledgerDb.getBySeq(db, 's1', 1)!.status).toBe('open');
  });

  it('a message sent before the item was created never counts', () => {
    messagesDb.append(db, { terminalId: 'coord', source: 'user', text: 'A', sentAt: min(-1) });
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'A' }), 422);
  });

  it('an "ok"-only answer fails with the ok text', () => {
    userSays('ok', 5);
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'ok' }), 422, OK_ONLY_ERROR);
  });

  it('parked needs a quote too; withdrawn needs a reason and no quote', () => {
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'parked' }), 400);
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'withdrawn' }), 400);
    const out = ledger.resolve('s1', 'coord', { id: 'N1', status: 'withdrawn', reason: 'the agent found a built-in option' });
    expect(out.line).toBe('N1 [Decide] Which store goes first?\n  Withdrawn by overseer: the agent found a built-in option');
  });

  it('a closed item returns 409 with its current status; an unknown ID returns 404', () => {
    ledger.resolve('s1', 'coord', { id: 'N1', status: 'withdrawn', reason: 'moot' });
    const e = expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'withdrawn', reason: 'again' }), 409, 'N1 is already withdrawn.');
    expect(e.body).toEqual({ status: 'withdrawn' });
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N7', status: 'withdrawn', reason: 'x' }), 404, 'Unknown ledger item: N7');
  });
});

describe('note', () => {
  it('creates a statement from a checked quote, with an optional reading', () => {
    userSays('never touch the archive table, ok?', 1);
    const out = ledger.note('s1', 'coord', { quote: 'never touch the archive table', reading: 'no agent writes to archive_* tables' });
    expect(out).toEqual({ id: 'N1', line: 'N1 You said: "never touch the archive table" (Mon 16:01)\n  I read this as: no agent writes to archive_* tables' });
    expect(ledgerDb.getBySeq(db, 's1', 1)).toMatchObject({ kind: 'statement', author: 'you', status: 'answered' });
  });

  it('fails for words the user did not write, and for an ok-only quote', () => {
    userSays('ok', 1);
    expectLedgerError(() => ledger.note('s1', 'coord', { quote: 'always deploy on Fridays' }), 422, QUOTE_NOT_FOUND_STATEMENT_ERROR);
    expectLedgerError(() => ledger.note('s1', 'coord', { quote: 'ok' }), 422, OK_ONLY_ERROR);
  });
});

describe('list', () => {
  it('renders the sections; forRecap stamps lastRecapAt and clears interimDueAt', () => {
    terminalsDb.updateConfig(db, 'coord', { role: 'coordinator', transport: 'structured', interimDueAt: min(20) });
    ledger.add('s1', 'coord', { kind: 'go', text: 'Merge PR #12.' });
    const plain = ledger.list('s1', 'coord');
    expect(plain.text).toContain('Needs you now:\n- N1 [Go] Merge PR #12. (open 0m)');
    expect(plain.openIds).toEqual(['N1']);
    expect(JSON.parse(terminalsDb.getById(db, 'coord')!.config!).interimDueAt).toBe(min(20)); // a plain list changes nothing

    now = T0 + 30 * 60_000;
    ledger.list('s1', 'coord', { forRecap: true });
    const cfg = JSON.parse(terminalsDb.getById(db, 'coord')!.config!);
    expect(cfg.lastRecapAt).toBe(min(30));
    expect(cfg.interimDueAt).toBeUndefined();
    expect(cfg.role).toBe('coordinator'); // the rest of the config survives
  });
});

describe('import', () => {
  it('loads items as imported; an unchecked imported decision can be confirmed with a quote', () => {
    const out = ledger.importItems('s1', 'coord', [
      { kind: 'go', text: 'Merge PR #9.' },
      { kind: 'decide', text: 'Use library A?', status: 'answered' },
      { kind: 'statement', text: 'keep prices as they are' },
    ]);
    expect(out).toEqual({ ids: ['N1', 'N2', 'N3'] });
    expect(ledgerDb.listBySession(db, 's1').map((i) => [i.origin, i.status, i.author])).toEqual([
      ['imported', 'open', 'overseer'], ['imported', 'answered', 'overseer'], ['imported', 'answered', 'you'],
    ]);
    expect(ledger.list('s1', 'coord').text).toContain('- N2 [Decide] Use library A?\n  Imported, not checked');

    userSays('yes, library A', 2);
    const confirmed = ledger.resolve('s1', 'coord', { id: 'N2', status: 'answered', quote: 'library A' });
    expect(confirmed.line).toContain('You approved: "Use library A?" → "library A"');
    expectLedgerError(() => ledger.resolve('s1', 'coord', { id: 'N2', status: 'answered', quote: 'library A' }), 409);
  });

  it('rejects an empty list or a bad item, and creates nothing', () => {
    expectLedgerError(() => ledger.importItems('s1', 'coord', []), 400);
    expectLedgerError(() => ledger.importItems('s1', 'coord', [{ kind: 'go', text: 'ok' }, { kind: 'nope', text: 'x' }]), 400);
    expect(ledgerDb.listBySession(db, 's1')).toEqual([]);
  });
});

describe('handoff', () => {
  it('renders the verbatim block for the given IDs, and 404s an unknown ID', () => {
    ledger.add('s1', 'coord', { kind: 'decide', text: 'Use library A?' });
    userSays('A', 1);
    ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'A' });
    expect(ledger.handoff('s1', 'coord', ['N1']).block).toBe(
      'Owner decisions (verbatim, from the ledger):\n- N1 [Decide] Use library A?\n  You approved: "Use library A?" → "A" (Mon 16:01)',
    );
    expectLedgerError(() => ledger.handoff('s1', 'coord', ['N1', 'N5']), 404, 'Unknown ledger item: N5');
  });
});
```

`packages/core/tests/routes/ledger.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as messagesDb from '../../src/db/coordinator-messages.js';

describe('ledger routes', () => {
  let app: any;
  let db: Database.Database;
  let sid: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true });
    sid = (await request(app).post('/api/sessions').send({ provider: 'claude-code', workingDir: '/tmp', name: 'ledger' })).body.id;
    terminalsDb.create(db, { id: 'coord', sessionId: sid, type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
    terminalsDb.create(db, { id: 'agent', sessionId: sid, type: 'claude-code', label: 'worker', config: { role: 'agent' } });
  });

  it('POST /ledger creates N1 (201); a non-overseer gets 403 with the fixed text', async () => {
    const ok = await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: 'coord', kind: 'go', text: 'Merge PR #12.' }).expect(201);
    expect(ok.body.id).toBe('N1');
    expect(ok.body.line).toContain('N1 [Go] Merge PR #12.');
    const denied = await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: 'agent', kind: 'go', text: 'x' }).expect(403);
    expect(denied.body.error).toBe("Only the project's overseer can change the ledger.");
  });

  it('resolve: 404 unknown, 422 quote not found, 200 found, then 409 with the status', async () => {
    await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: 'coord', kind: 'decide', text: 'Which store?' }).expect(201);
    await request(app).post(`/api/sessions/${sid}/ledger/N9/resolve`).send({ caller: 'coord', status: 'answered', quote: 'A' }).expect(404);
    const missing = await request(app).post(`/api/sessions/${sid}/ledger/N1/resolve`).send({ caller: 'coord', status: 'answered', quote: 'A' }).expect(422);
    expect(missing.body.error).toBe("Quote not found in the user's messages to you after N1 was created. Do not record it. Ask the user.");
    messagesDb.append(db, { terminalId: 'coord', source: 'user', text: 'A please', sentAt: new Date(Date.now() + 1000).toISOString() });
    await request(app).post(`/api/sessions/${sid}/ledger/N1/resolve`).send({ caller: 'coord', status: 'answered', quote: 'A please' }).expect(200);
    const again = await request(app).post(`/api/sessions/${sid}/ledger/N1/resolve`).send({ caller: 'coord', status: 'parked', quote: 'A please' }).expect(409);
    expect(again.body).toEqual({ error: 'N1 is already answered.', status: 'answered' });
  });

  it('list, note, import and handoff answer on their routes', async () => {
    await request(app).post(`/api/sessions/${sid}/ledger/import`).send({ caller: 'coord', items: [{ kind: 'do', text: 'Check staging.' }] }).expect(201);
    const list = await request(app).post(`/api/sessions/${sid}/ledger/list`).send({ caller: 'coord', forRecap: true }).expect(200);
    expect(list.body.text).toContain('Your tests and actions:\n- N1 [Do] Check staging.');
    expect(JSON.parse(terminalsDb.getById(db, 'coord')!.config!).lastRecapAt).toEqual(expect.any(String));
    await request(app).post(`/api/sessions/${sid}/ledger/note`).send({ caller: 'coord', quote: 'never on Fridays' }).expect(422);
    const handoff = await request(app).post(`/api/sessions/${sid}/ledger/handoff`).send({ caller: 'coord', ids: ['N1'] }).expect(200);
    expect(handoff.body.block.startsWith('Owner decisions (verbatim, from the ledger):\n- N1 [Do] Check staging.')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run tests/overseer/ledger-service.test.ts tests/routes/ledger.test.ts`
Expected: FAIL. The service test reports `Failed to load url ../../src/overseer/ledger-service.js`. The route tests get `404` from Express instead of `201`.

- [ ] **Step 3: Write the implementation**

`packages/core/src/overseer/ledger-service.ts`:

```ts
/**
 * The decision ledger (structured-recap spec, Units 2 and 3): the rules the daemon enforces.
 *
 * 1. Only the project's overseer can change the ledger: the caller must be a non-archived
 *    `config.role === 'coordinator'` terminal in the same session (403 otherwise).
 * 2. A claim about the user needs a checked quote (answered, parked, a statement).
 * 3. Item text never changes; a wider scope is a new item with `supersedes`.
 * 4. Without a quote, the overseer can close an item only as `withdrawn`, with a reason.
 * 5. Imported items stay "Imported, not checked" until the user confirms one and the overseer
 *    records that quote — so an unchecked imported item can be resolved once more.
 * 6. A leading "ok" never counts (see ledger-quote.ts).
 */
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import * as ledgerDb from '../db/ledger.js';
import * as messagesDb from '../db/coordinator-messages.js';
import { findQuote, OK_ONLY_ERROR } from './ledger-quote.js';
import { isUnchecked, renderHandoffBlock, renderItem, renderLedgerSections, type RenderContext } from './ledger-render.js';

export const NOT_OVERSEER_ERROR = "Only the project's overseer can change the ledger.";
export const QUOTE_NOT_FOUND_STATEMENT_ERROR = "Quote not found in the user's messages to you. Do not record it. Ask the user.";
export function quoteNotFoundAfterError(seq: number): string {
  return `Quote not found in the user's messages to you after N${seq} was created. Do not record it. Ask the user.`;
}

/** Coordinator config keys this feature owns. */
export const LAST_RECAP_KEY = 'lastRecapAt';
export const INTERIM_DUE_KEY = 'interimDueAt';

/** An error with the HTTP status the route returns, plus extra JSON fields for the body. */
export class LedgerError extends Error {
  constructor(readonly status: number, message: string, readonly body: Record<string, unknown> = {}) {
    super(message);
  }
}

/** "N12", "n12" or "12" (or the number 12) → 12. Anything else → null. */
export function parseLedgerId(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^N?(\d+)$/i);
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function strList(v: unknown, field: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new LedgerError(400, `${field} must be an array of strings`);
  const list = v.map((x: string) => x.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

const OPEN_KINDS = new Set(['go', 'decide', 'do']);
const IMPORT_KINDS = new Set(['go', 'decide', 'do', 'statement']);
const IMPORT_STATUSES = new Set(['open', 'answered', 'parked']);

export class LedgerService {
  private readonly clock: () => number;
  private readonly timeZone?: string;

  constructor(private readonly db: Database.Database, opts: { clock?: () => number; timeZone?: string } = {}) {
    this.clock = opts.clock ?? (() => Date.now());
    this.timeZone = opts.timeZone;
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  private ctx(sessionId: string): RenderContext {
    return { now: this.clock(), timeZone: this.timeZone, lookup: (seq) => ledgerDb.getBySeq(this.db, sessionId, seq) };
  }

  /** Rule 1. Returns the overseer's terminal row. */
  assertOverseer(sessionId: string, caller: unknown): terminalsDb.TerminalRow {
    const row = typeof caller === 'string' && caller ? terminalsDb.getById(this.db, caller) : null;
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(row?.config || '{}'); } catch { /* default {} */ }
    if (!row || row.archived_at || row.session_id !== sessionId || cfg.role !== 'coordinator') {
      throw new LedgerError(403, NOT_OVERSEER_ERROR);
    }
    return row;
  }

  private requireItem(sessionId: string, rawId: unknown): ledgerDb.LedgerItem {
    const seq = parseLedgerId(rawId);
    if (seq === null) throw new LedgerError(400, 'id must be a ledger item ID such as N12');
    const item = ledgerDb.getBySeq(this.db, sessionId, seq);
    if (!item) throw new LedgerError(404, `Unknown ledger item: N${seq}`);
    return item;
  }

  private userMessages(overseerId: string, after: string | null) {
    return messagesDb.listUserMessages(this.db, overseerId, after);
  }

  add(sessionId: string, caller: unknown, input: Record<string, unknown>): { id: string; line: string } {
    this.assertOverseer(sessionId, caller);
    const kind = input.kind;
    if (typeof kind !== 'string' || !OPEN_KINDS.has(kind)) throw new LedgerError(400, "kind must be 'go', 'decide' or 'do'");
    const text = str(input.text);
    if (!text) throw new LedgerError(400, 'text is required');
    let supersedes: number | undefined;
    if (input.supersedes !== undefined && input.supersedes !== null && input.supersedes !== '') {
      supersedes = this.requireItem(sessionId, input.supersedes).seq;
    }
    const item = ledgerDb.create(this.db, {
      sessionId,
      kind: kind as ledgerDb.LedgerKind,
      text,
      author: str(input.author) ?? 'overseer',
      recommendation: str(input.recommendation),
      options: strList(input.options, 'options'),
      blocks: str(input.blocks),
      mission: str(input.mission),
      supersedes,
      now: this.nowIso(),
    });
    return { id: `N${item.seq}`, line: renderItem(item, this.ctx(sessionId)) };
  }

  resolve(sessionId: string, caller: unknown, input: Record<string, unknown>): { id: string; status: string; line: string } {
    const overseer = this.assertOverseer(sessionId, caller);
    const status = input.status;
    if (status !== 'answered' && status !== 'parked' && status !== 'withdrawn') {
      throw new LedgerError(400, "status must be 'answered', 'parked' or 'withdrawn'");
    }
    const item = this.requireItem(sessionId, input.id);
    if (item.status !== 'open' && !isUnchecked(item)) {
      throw new LedgerError(409, `N${item.seq} is already ${item.status}.`, { status: item.status });
    }
    const reading = str(input.reading);
    if (status === 'withdrawn') {
      const reason = str(input.reason);
      if (!reason) throw new LedgerError(400, 'reason is required to withdraw an item');
      const updated = ledgerDb.updateStatus(this.db, sessionId, item.seq, { status, reason, reading, now: this.nowIso() })!;
      return { id: `N${item.seq}`, status, line: renderItem(updated, this.ctx(sessionId)) };
    }
    const quote = str(input.quote);
    if (!quote) throw new LedgerError(400, 'quote is required for answered and parked');
    const match = findQuote(quote, this.userMessages(overseer.id, item.createdAt), { after: item.createdAt });
    if (!match.ok) throw new LedgerError(422, match.reason === 'ok_only' ? OK_ONLY_ERROR : quoteNotFoundAfterError(item.seq));
    const updated = ledgerDb.updateStatus(this.db, sessionId, item.seq, {
      status, quote: match.quote, quoteMessageId: match.messageId, quoteAt: match.sentAt, reading, now: this.nowIso(),
    })!;
    return { id: `N${item.seq}`, status, line: renderItem(updated, this.ctx(sessionId)) };
  }

  note(sessionId: string, caller: unknown, input: Record<string, unknown>): { id: string; line: string } {
    const overseer = this.assertOverseer(sessionId, caller);
    const quote = str(input.quote);
    if (!quote) throw new LedgerError(400, 'quote is required');
    const match = findQuote(quote, this.userMessages(overseer.id, null), { after: null });
    if (!match.ok) throw new LedgerError(422, match.reason === 'ok_only' ? OK_ONLY_ERROR : QUOTE_NOT_FOUND_STATEMENT_ERROR);
    const item = ledgerDb.create(this.db, {
      sessionId,
      kind: 'statement',
      text: match.quote,
      author: 'you',
      mission: str(input.mission),
      status: 'answered',
      quote: match.quote,
      quoteMessageId: match.messageId,
      quoteAt: match.sentAt,
      reading: str(input.reading),
      now: this.nowIso(),
    });
    return { id: `N${item.seq}`, line: renderItem(item, this.ctx(sessionId)) };
  }

  /** The rendered ledger part of a recap. `forRecap` stamps lastRecapAt and clears the interim timer. */
  list(sessionId: string, caller: unknown, opts: { forRecap?: boolean } = {}): { text: string; openIds: string[] } {
    const overseer = this.assertOverseer(sessionId, caller);
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(overseer.config || '{}'); } catch { /* default {} */ }
    const lastRecapAt = typeof cfg[LAST_RECAP_KEY] === 'string' ? (cfg[LAST_RECAP_KEY] as string) : null;
    const items = ledgerDb.listBySession(this.db, sessionId);
    const text = renderLedgerSections(items, { now: this.clock(), lastRecapAt, timeZone: this.timeZone });
    if (opts.forRecap) {
      cfg[LAST_RECAP_KEY] = this.nowIso();
      delete cfg[INTERIM_DUE_KEY];
      terminalsDb.updateConfig(this.db, overseer.id, cfg);
    }
    return { text, openIds: items.filter((i) => i.status === 'open').map((i) => `N${i.seq}`) };
  }

  /** One-time load of open items and earlier decisions from the overseer's context. */
  importItems(sessionId: string, caller: unknown, rawItems: unknown): { ids: string[] } {
    this.assertOverseer(sessionId, caller);
    if (!Array.isArray(rawItems) || rawItems.length === 0) throw new LedgerError(400, 'items must be a non-empty array');
    const inputs = rawItems.map((raw, i): ledgerDb.CreateLedgerInput => {
      const it = (raw ?? {}) as Record<string, unknown>;
      const kind = it.kind;
      if (typeof kind !== 'string' || !IMPORT_KINDS.has(kind)) throw new LedgerError(400, `items[${i}].kind must be 'go', 'decide', 'do' or 'statement'`);
      const text = str(it.text);
      if (!text) throw new LedgerError(400, `items[${i}].text is required`);
      const status = it.status === undefined ? (kind === 'statement' ? 'answered' : 'open') : it.status;
      if (typeof status !== 'string' || !IMPORT_STATUSES.has(status)) throw new LedgerError(400, `items[${i}].status must be 'open', 'answered' or 'parked'`);
      return {
        sessionId,
        kind: kind as ledgerDb.LedgerKind,
        text,
        author: kind === 'statement' ? 'you' : (str(it.author) ?? 'overseer'),
        recommendation: str(it.recommendation),
        options: strList(it.options, `items[${i}].options`),
        blocks: str(it.blocks),
        mission: str(it.mission),
        reading: str(it.reading),
        status: (kind === 'statement' ? 'answered' : status) as ledgerDb.LedgerStatus,
        origin: 'imported',
        now: this.nowIso(),
      };
    });
    const created = this.db.transaction(() => inputs.map((input) => ledgerDb.create(this.db, input)))();
    return { ids: created.map((i) => `N${i.seq}`) };
  }

  /** The "Owner decisions (verbatim, from the ledger)" block for an agent hand-off. */
  handoff(sessionId: string, caller: unknown, rawIds: unknown): { block: string } {
    this.assertOverseer(sessionId, caller);
    if (!Array.isArray(rawIds) || rawIds.length === 0) throw new LedgerError(400, 'ids must be a non-empty array of ledger item IDs');
    const items = rawIds.map((raw) => this.requireItem(sessionId, raw));
    return { block: renderHandoffBlock(items, this.ctx(sessionId)) };
  }
}
```

`packages/core/src/routes/ledger.ts`:

```ts
import { Router, type Request, type Response } from 'express';
import { LedgerError, type LedgerService } from '../overseer/ledger-service.js';

/**
 * The decision ledger routes. Every route names the caller in the body (`caller`, the calling
 * terminal id that the dispatch MCP takes from DISPATCH_TERMINAL) and the service rejects any
 * caller that is not this project's overseer — the same trust level as the other agency routes.
 * `list` is a POST because `forRecap` changes the overseer's config.
 */
export function createLedgerRouter(ledger: LedgerService): Router {
  const router = Router();

  const handle = (status: number, run: (req: Request) => unknown) => (req: Request, res: Response) => {
    try {
      res.status(status).json(run(req));
    } catch (e: any) {
      if (e instanceof LedgerError) return res.status(e.status).json({ error: e.message, ...e.body });
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  };

  router.post('/sessions/:sessionId/ledger', handle(201, (req) => ledger.add(req.params.sessionId, req.body?.caller, req.body ?? {})));
  router.post('/sessions/:sessionId/ledger/list', handle(200, (req) => ledger.list(req.params.sessionId, req.body?.caller, { forRecap: req.body?.forRecap === true })));
  router.post('/sessions/:sessionId/ledger/note', handle(201, (req) => ledger.note(req.params.sessionId, req.body?.caller, req.body ?? {})));
  router.post('/sessions/:sessionId/ledger/import', handle(201, (req) => ledger.importItems(req.params.sessionId, req.body?.caller, req.body?.items)));
  router.post('/sessions/:sessionId/ledger/handoff', handle(200, (req) => ledger.handoff(req.params.sessionId, req.body?.caller, req.body?.ids)));
  router.post('/sessions/:sessionId/ledger/:itemId/resolve', handle(200, (req) => ledger.resolve(req.params.sessionId, req.body?.caller, { ...(req.body ?? {}), id: req.params.itemId })));

  return router;
}
```

`packages/core/src/server.ts` — after line 73 (`import { createWatchesRouter } from './routes/watches.js';`) add:

```ts
import { createLedgerRouter } from './routes/ledger.js';
import { LedgerService } from './overseer/ledger-service.js';
```

After line 347 (`app.use('/api', createTerminalsRouter(sessionService, undefined, statusService));`) add:

```ts
  app.use('/api', createLedgerRouter(new LedgerService(db)));
```

After line 643 (`app.use('/api', createTerminalsRouter(sessionService, broadcaster, statusService));`) add:

```ts
  app.use('/api', createLedgerRouter(new LedgerService(db)));
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd packages/core && npx vitest run tests/overseer/ledger-service.test.ts tests/routes/ledger.test.ts tests/routes/sessions.test.ts tests/routes/terminals.test.ts`
Expected: PASS (16 + 3 new tests; the existing route suites still green).

Run: `cd packages/core && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/overseer/ledger-service.ts packages/core/src/routes/ledger.ts packages/core/src/server.ts packages/core/tests/overseer/ledger-service.test.ts packages/core/tests/routes/ledger.test.ts
git commit -m "$(cat <<'EOF'
feat(core): ledger service and overseer-only routes with checked quotes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Ledger tools in the dispatch MCP, and `ledgerIds` hand-offs

**Files:**
- Modify: `packages/core/src/overseer/agency-mcp.ts:81` (constants), `:84-403` (TOOLS), `:439-458` (`spawnAgent`), `:468-487` (`queueAgent`), `:529-539` (`messageAgent`), `:757` (new functions before the post_image section), `:831` (`callTool`)
- Modify: `packages/core/tests/overseer/agency-mcp.test.ts:34-44`
- Modify: `packages/core/src/roles/role-policy.test.ts:392`
- Test: `packages/core/tests/overseer/agency-mcp-ledger.test.ts`

**Interfaces:**
- Consumes: the Task 5 routes; `requireSelf(action)` (`agency-mcp.ts:624`), `apiBase()`, `sessionId()` (`:41-46`).
- Produces: tools `ledger_add`, `ledger_resolve`, `ledger_note`, `ledger_list`, `ledger_import` (22 tools in all); a `ledgerIds?: string[]` argument on `spawn_agent`, `queue_agent`, `message_agent`. `ledger_list` returns the rendered text as its content block (not JSON). Every ledger request body carries `caller: DISPATCH_TERMINAL`.

- [ ] **Step 1: Write the failing tests**

`packages/core/tests/overseer/agency-mcp-ledger.test.ts`:

```ts
// The decision-ledger tools (structured-recap spec, Unit 3) and the `ledgerIds` hand-off on
// spawn_agent / queue_agent / message_agent. fetch is mocked, as in agency-mcp.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { callTool, TOOLS } from '../../src/overseer/agency-mcp.js';

const ok = (body: unknown, status = 200) => ({ ok: true, status, statusText: 'OK', text: async () => (body === undefined ? '' : JSON.stringify(body)) });
const fail = (status: number, error: string) => ({ ok: false, status, statusText: 'Err', text: async () => JSON.stringify({ error }) });
const BLOCK = 'Owner decisions (verbatim, from the ledger):\n- N7 [Go] Merge PR #12.\n  You approved: "Merge PR #12." → "merge N7" (Mon 16:51)';

describe('agency-mcp ledger tools', () => {
  const saved = { ...process.env };
  const origFetch = global.fetch;
  beforeEach(() => {
    process.env.DISPATCH_API = 'http://localhost:9999';
    process.env.DISPATCH_SESSION = 'sess-1';
    process.env.DISPATCH_TERMINAL = 'coord-1';
    delete process.env.DISPATCH_SPAWN_DEPTH;
  });
  afterEach(() => {
    global.fetch = origFetch;
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it('ledger_add POSTs the item with the caller identity and returns { id, line }', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok({ id: 'N8', line: 'N8 [Decide] Which store? (open 0m)\n  Proposed by overseer, not approved' }, 201));
    global.fetch = fetchMock as any;
    const out = await callTool('ledger_add', { kind: 'decide', text: 'Which store?', options: ['A', 'B'], caller: 'someone-else' });
    expect(out.isError).toBeUndefined();
    expect(JSON.parse((out.content[0] as any).text)).toEqual({ id: 'N8', line: 'N8 [Decide] Which store? (open 0m)\n  Proposed by overseer, not approved' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:9999/api/sessions/sess-1/ledger');
    expect(JSON.parse(init.body)).toEqual({ kind: 'decide', text: 'Which store?', options: ['A', 'B'], caller: 'coord-1' }); // caller is always self
  });

  it('ledger_resolve POSTs to the item route and surfaces the route error text as is', async () => {
    const msg = "Quote not found in the user's messages to you after N12 was created. Do not record it. Ask the user.";
    const fetchMock = vi.fn().mockResolvedValueOnce(fail(422, msg));
    global.fetch = fetchMock as any;
    const out = await callTool('ledger_resolve', { id: 'N12', status: 'answered', quote: 'yes' });
    expect(out.isError).toBe(true);
    expect((out.content[0] as any).text).toBe(`Error: ${msg}`);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:9999/api/sessions/sess-1/ledger/N12/resolve');
    expect(JSON.parse(init.body)).toEqual({ status: 'answered', quote: 'yes', caller: 'coord-1' });
  });

  it('ledger_note and ledger_import POST to their routes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ id: 'N3', line: 'N3 You said: "never on Fridays" (Mon 16:51)' }, 201))
      .mockResolvedValueOnce(ok({ ids: ['N4'] }, 201));
    global.fetch = fetchMock as any;
    await callTool('ledger_note', { quote: 'never on Fridays' });
    await callTool('ledger_import', { items: [{ kind: 'go', text: 'Merge PR #9.' }] });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/api/sessions/sess-1/ledger/note');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ quote: 'never on Fridays', caller: 'coord-1' });
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:9999/api/sessions/sess-1/ledger/import');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ caller: 'coord-1', items: [{ kind: 'go', text: 'Merge PR #9.' }] });
  });

  it('ledger_list returns the rendered text itself, not a JSON string', async () => {
    const text = 'Needs you now:\n- none\n\nYour tests and actions:\n- none';
    const fetchMock = vi.fn().mockResolvedValueOnce(ok({ text, openIds: [] }));
    global.fetch = fetchMock as any;
    const out = await callTool('ledger_list', { forRecap: true });
    expect(out.content).toEqual([{ type: 'text', text }]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ caller: 'coord-1', forRecap: true });
  });

  it('a ledger tool fails clearly without a caller identity and never calls the daemon', async () => {
    delete process.env.DISPATCH_TERMINAL;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;
    const out = await callTool('ledger_list', {});
    expect(out.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('spawn_agent with ledgerIds fetches the hand-off block first and appends it to the task', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ block: BLOCK }))
      .mockResolvedValueOnce(ok({ harness: 'claude-code', available: true }))
      .mockResolvedValueOnce(ok({ id: 'agent-1', label: 'implementer agent' }, 201))
      .mockResolvedValueOnce(ok(undefined, 204));
    global.fetch = fetchMock as any;
    const out = await callTool('spawn_agent', { agentType: 'implementer', task: 'merge the PR', ledgerIds: ['N7'] });
    expect(out.isError).toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/api/sessions/sess-1/ledger/handoff');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ caller: 'coord-1', ids: ['N7'] });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ text: `merge the PR\n\n${BLOCK}`, source: 'coordinator' });
  });

  it('spawn_agent with an unknown ledger ID fails before any thread exists', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(fail(404, 'Unknown ledger item: N99'));
    global.fetch = fetchMock as any;
    const out = await callTool('spawn_agent', { agentType: 'implementer', task: 'x', ledgerIds: ['N99'] });
    expect(out.isError).toBe(true);
    expect((out.content[0] as any).text).toBe('Error: Unknown ledger item: N99');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('queue_agent parks the task with the block appended', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ block: BLOCK }))
      .mockResolvedValueOnce(ok({ harness: 'claude-code', available: true }))
      .mockResolvedValueOnce(ok({ id: 'q1', label: 'implementer agent' }, 201));
    global.fetch = fetchMock as any;
    await callTool('queue_agent', { agentType: 'implementer', task: 'merge later', ledgerIds: ['N7'] });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).task).toBe(`merge later\n\n${BLOCK}`);
  });

  it('message_agent sends the text with the block appended', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ block: BLOCK }))
      .mockResolvedValueOnce(ok(undefined, 204));
    global.fetch = fetchMock as any;
    await callTool('message_agent', { agentId: 'a1', text: 'go ahead', ledgerIds: ['N7'] });
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:9999/api/terminals/a1/message');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ text: `go ahead\n\n${BLOCK}`, source: 'coordinator' });
  });

  it('spawn_agent, queue_agent and message_agent declare ledgerIds in their schemas', () => {
    for (const name of ['spawn_agent', 'queue_agent', 'message_agent']) {
      const tool = TOOLS.find((t) => t.name === name)! as any;
      expect(tool.inputSchema.properties.ledgerIds.type).toBe('array');
    }
  });
});
```

In `packages/core/tests/overseer/agency-mcp.test.ts`, replace lines 38-43:

```ts
    expect(names).toEqual([
      'answer_agent', 'complete_agent', 'list_agents', 'list_missions', 'list_threads', 'list_watches',
      'message_agent', 'message_thread', 'post_image', 'queue_agent', 'read_agent', 'read_thread',
      'report_status', 'spawn_agent', 'start_agent', 'unwatch_thread', 'watch_thread',
    ]);
    expect(TOOLS).toHaveLength(17);
```

with:

```ts
    expect(names).toEqual([
      'answer_agent', 'complete_agent', 'ledger_add', 'ledger_import', 'ledger_list', 'ledger_note',
      'ledger_resolve', 'list_agents', 'list_missions', 'list_threads', 'list_watches',
      'message_agent', 'message_thread', 'post_image', 'queue_agent', 'read_agent', 'read_thread',
      'report_status', 'spawn_agent', 'start_agent', 'unwatch_thread', 'watch_thread',
    ]);
    expect(TOOLS).toHaveLength(22);
```

In `packages/core/src/roles/role-policy.test.ts`, insert before line 392 (`it('fails closed on a Dispatch tool it does not know …`):

```ts
  it('denies the decision-ledger tools to a role run (they are not on the allowlist)', () => {
    for (const [level, policy] of levels) {
      for (const tool of ['ledger_add', 'ledger_resolve', 'ledger_note', 'ledger_list', 'ledger_import']) {
        expect(policy(`mcp__dispatch__${tool}`, {}).allow, `${level} ${tool}`).toBe(false);
      }
    }
  });

```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run tests/overseer/agency-mcp-ledger.test.ts tests/overseer/agency-mcp.test.ts src/roles/role-policy.test.ts`
Expected: FAIL. The tool-list test fails (17 names, not 22). The ledger tools return `Error: Unknown tool: ledger_add`. The `ledgerIds` tests fail because no hand-off fetch happens. The role-policy pin passes at once (the policy fails closed already); it guards that behaviour.

- [ ] **Step 3: Write the implementation**

All edits are in `packages/core/src/overseer/agency-mcp.ts`.

(a) After `HARNESS_ARG_DESCRIPTION` (line 81, `'benefits from a specific harness.';`) add:

```ts

/** spawn_agent/queue_agent/message_agent `ledgerIds` arg (structured-recap spec, Unit 3 hand-offs). */
const LEDGER_IDS_ARG_DESCRIPTION =
  'Optional ledger item IDs (e.g. ["N7", "N12"]). The daemon appends a block "Owner decisions ' +
  '(verbatim, from the ledger)" with those items\' rendered lines, so the agent gets the question and ' +
  "the user's exact words, not a paraphrase. Overseer only.";

const LEDGER_IDS_SCHEMA = { type: 'array', items: { type: 'string' }, description: LEDGER_IDS_ARG_DESCRIPTION } as const;
```

(b) In the `spawn_agent` and the `queue_agent` schemas, after the `harness: { … description: HARNESS_ARG_DESCRIPTION, },` property (lines 119-123 and 172-176), add:

```ts
        ledgerIds: LEDGER_IDS_SCHEMA,
```

In the `message_agent` schema, after `text: { type: 'string', description: 'The message to send to the agent.' },` (line 215), add the same line.

(c) Replace the end of the `TOOLS` array (lines 400-403):

```ts
      required: ['state', 'summary'],
    },
  },
] as const;
```

with:

```ts
      required: ['state', 'summary'],
    },
  },
  // --- decision ledger (structured-recap spec, Unit 3): overseer only; the routes reject others ---
  {
    name: 'ledger_add',
    description:
      'Overseer only. Record an item that needs the user in the decision ledger: kind "go" (a merge, ' +
      'deploy or release approval), "decide" (a choice) or "do" (a manual step for the user). Every ' +
      'question to the user goes here first. Returns { id, line }: post `line` to the user as is. The ' +
      'item text never changes; for a wider scope, add a new item with `supersedes`.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['go', 'decide', 'do'], description: 'go = merge/deploy/release approval, decide = a choice, do = a manual step for the user.' },
        text: { type: 'string', description: 'The item as the user will see it. It never changes after creation.' },
        recommendation: { type: 'string', description: 'Optional: what you recommend.' },
        options: { type: 'array', items: { type: 'string' }, description: 'Optional: the choices, for a decide item.' },
        blocks: { type: 'string', description: 'Optional: what this item holds up.' },
        mission: { type: 'string', description: 'Optional mission name this item belongs to.' },
        author: { type: 'string', description: 'Optional: who proposed it, "overseer" (the default) or an agent label.' },
        supersedes: { type: 'string', description: 'Optional: the ID (e.g. "N3") of an older item that this item replaces or widens.' },
      },
      required: ['kind', 'text'],
    },
  },
  {
    name: 'ledger_resolve',
    description:
      'Overseer only. Close a ledger item. "answered" and "parked" need `quote`: the user\'s exact words, ' +
      'which the daemon checks against the messages the user sent you after the item was created. ' +
      '"withdrawn" needs `reason`. An "ok" at the start of a message is never an answer. If the check ' +
      'fails, do not record the item: ask the user.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The item ID, e.g. "N12".' },
        status: { type: 'string', enum: ['answered', 'parked', 'withdrawn'], description: 'The new status.' },
        quote: { type: 'string', description: "The user's exact words. Required for answered and parked." },
        reading: { type: 'string', description: 'Optional "I read this as: …" line, when you apply the answer more widely than the words say.' },
        reason: { type: 'string', description: 'Why you withdraw the item. Required for withdrawn.' },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'ledger_note',
    description:
      'Overseer only. Record a statement the user made (a rule, a preference, a fact) with the user\'s ' +
      'exact words as `quote`; the daemon checks the words against the user\'s messages to you. Add ' +
      '`reading` when you apply it more widely than the words say.',
    inputSchema: {
      type: 'object',
      properties: {
        quote: { type: 'string', description: "The user's exact words." },
        reading: { type: 'string', description: 'Optional "I read this as: …" line.' },
        mission: { type: 'string', description: 'Optional mission name this statement belongs to.' },
      },
      required: ['quote'],
    },
  },
  {
    name: 'ledger_list',
    description:
      'Overseer only. The rendered ledger part of a recap: Needs you now, Your tests and actions, Decided ' +
      'since the last recap, Parked. Paste these lines as is. Pass forRecap: true when you post the recap: ' +
      'it marks the recap as posted and clears the interim recap timer.',
    inputSchema: {
      type: 'object',
      properties: {
        forRecap: { type: 'boolean', description: 'True when you are posting the recap now.' },
      },
    },
  },
  {
    name: 'ledger_import',
    description:
      'Overseer only. Use once, at rollout: load the open items and earlier decisions from your current ' +
      'context. They show as "Imported, not checked" until the user confirms one and you record the quote ' +
      'with ledger_resolve.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['go', 'decide', 'do', 'statement'] },
              text: { type: 'string' },
              status: { type: 'string', enum: ['open', 'answered', 'parked'] },
              author: { type: 'string' },
              recommendation: { type: 'string' },
              options: { type: 'array', items: { type: 'string' } },
              blocks: { type: 'string' },
              mission: { type: 'string' },
              reading: { type: 'string' },
            },
            required: ['kind', 'text'],
          },
          description: 'The items to import.',
        },
      },
      required: ['items'],
    },
  },
] as const;
```

(d) `spawnAgent` (line 439): change the signature to take `ledgerIds?: string[]`, fetch the block right after the depth check, and send `task`:

```ts
async function spawnAgent(args: { agentType: AgentType; name?: string; task: string; mission?: string; model?: string; harness?: string; ledgerIds?: string[] }): Promise<{ agentId: string; label: string; mission?: string }> {
  if (!args?.agentType) throw new Error('agentType is required');
  if (!args?.task) throw new Error('task is required');
  const depthCheck = checkSpawnDepth(selfSpawnDepth());
  if (!depthCheck.ok) throw new Error(depthCheck.reason);
  // Before anything is created: an unknown ledger ID fails the spawn cleanly.
  const task = await withLedgerBlock(args.task, args.ledgerIds);
```

(the lines from `const label = …` down to the create call stay as they are), and replace line 456:

```ts
  await httpJson('POST', `${apiBase()}/api/terminals/${agentId}/message`, { text: args.task, source: 'coordinator' });
```

with:

```ts
  await httpJson('POST', `${apiBase()}/api/terminals/${agentId}/message`, { text: task, source: 'coordinator' });
```

(e) `queueAgent` (line 468): same pattern —

```ts
async function queueAgent(args: { agentType: AgentType; name?: string; task: string; mission?: string; dependsOn?: string; model?: string; harness?: string; ledgerIds?: string[] }): Promise<{ agentId: string; label: string; mission?: string; queued: true }> {
  if (!args?.agentType) throw new Error('agentType is required');
  if (!args?.task) throw new Error('task is required');
  const depthCheck = checkSpawnDepth(selfSpawnDepth());
  if (!depthCheck.ok) throw new Error(depthCheck.reason);
  const task = await withLedgerBlock(args.task, args.ledgerIds);
```

and replace line 483:

```ts
    buildWorkerCreateBody({ agentType: args.agentType, label, resolved, explicitModel: model, mission, spawnDepth: childDepth, queued: true, task: args.task, dependsOn }));
```

with:

```ts
    buildWorkerCreateBody({ agentType: args.agentType, label, resolved, explicitModel: model, mission, spawnDepth: childDepth, queued: true, task, dependsOn }));
```

(f) Replace `messageAgent` (lines 529-539) with:

```ts
async function messageAgent(args: { agentId: string; text: string; ledgerIds?: string[] }): Promise<{ ok: true; agentId: string }> {
  if (!args?.agentId) throw new Error('agentId is required');
  if (!args?.text) throw new Error('text is required');
  const self = selfTerminalId();
  const selfCheck = checkSelfTarget(self, args.agentId, 'message');
  if (!selfCheck.ok) throw new Error(selfCheck.reason);
  const rateCheck = pairRateLimiter.check(self, args.agentId);
  if (!rateCheck.ok) throw new Error(rateCheck.reason);
  const text = await withLedgerBlock(args.text, args.ledgerIds);
  await httpJson('POST', `${apiBase()}/api/terminals/${args.agentId}/message`, { text, source: 'coordinator' });
  return { ok: true, agentId: args.agentId };
}
```

(g) Insert before line 757 (`// --- post_image (surface a picture inline in the coordinator thread) -------`):

```ts
// --- decision ledger (structured-recap spec, Unit 3) -------------------------

/**
 * POST to a ledger route and surface the route's own `{ error }` text as the tool error, never
 * httpJson's "<method> <url> -> <status>" wrapper: the quote-check failures are fixed sentences
 * the overseer must read as is ("… Do not record it. Ask the user.").
 */
async function ledgerRequest(suffix: string, body: Record<string, unknown>): Promise<any> {
  const url = `${apiBase()}/api/sessions/${sessionId()}/ledger${suffix}`;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text().catch(() => '');
  let data: any = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (!res.ok) throw new Error(data?.error || `POST ${url} -> ${res.status} ${res.statusText}`);
  return data;
}

/** Append the "Owner decisions (verbatim, from the ledger)" block for `ledgerIds`; unchanged (and no fetch) when there are none. */
async function withLedgerBlock(text: string, ledgerIds: unknown): Promise<string> {
  if (!Array.isArray(ledgerIds) || ledgerIds.length === 0) return text;
  const caller = requireSelf('hand ledger items to an agent');
  const data = await ledgerRequest('/handoff', { caller, ids: ledgerIds });
  return `${text}\n\n${data.block}`;
}

async function ledgerAdd(args: Record<string, unknown>): Promise<{ id: string; line: string }> {
  if (!args?.kind) throw new Error('kind is required');
  if (!args?.text) throw new Error('text is required');
  return ledgerRequest('', { ...args, caller: requireSelf('use the ledger') });
}

async function ledgerResolve(args: Record<string, unknown>): Promise<{ id: string; status: string; line: string }> {
  if (!args?.id) throw new Error('id is required');
  if (!args?.status) throw new Error('status is required');
  const { id, ...rest } = args;
  return ledgerRequest(`/${encodeURIComponent(String(id))}/resolve`, { ...rest, caller: requireSelf('use the ledger') });
}

async function ledgerNote(args: Record<string, unknown>): Promise<{ id: string; line: string }> {
  if (!args?.quote) throw new Error('quote is required');
  return ledgerRequest('/note', { ...args, caller: requireSelf('use the ledger') });
}

/** Returns the rendered text itself (not JSON), so the overseer can paste it as is. */
async function ledgerList(args: { forRecap?: boolean }): Promise<string> {
  const data = await ledgerRequest('/list', { caller: requireSelf('use the ledger'), forRecap: args?.forRecap === true });
  return String(data?.text ?? '');
}

async function ledgerImport(args: { items?: unknown }): Promise<{ ids: string[] }> {
  if (!Array.isArray(args?.items)) throw new Error('items is required');
  return ledgerRequest('/import', { caller: requireSelf('use the ledger'), items: args.items });
}

```

(h) In `callTool`, after line 831 (`case 'report_status': result = await reportStatus(args ?? {}); break;`) add:

```ts
      case 'ledger_add': result = await ledgerAdd(args ?? {}); break;
      case 'ledger_resolve': result = await ledgerResolve(args ?? {}); break;
      case 'ledger_note': result = await ledgerNote(args ?? {}); break;
      case 'ledger_import': result = await ledgerImport(args ?? {}); break;
      // ledger_list's result IS the text to paste — return it as is, not as a JSON string.
      case 'ledger_list': return { content: [{ type: 'text', text: await ledgerList(args ?? {}) }] };
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd packages/core && npx vitest run tests/overseer/agency-mcp-ledger.test.ts tests/overseer/agency-mcp.test.ts src/roles/role-policy.test.ts`
Expected: PASS (every existing spawn/queue/message test still counts the same fetch calls: without `ledgerIds` there is no extra fetch).

Run: `cd packages/core && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/overseer/agency-mcp.ts packages/core/tests/overseer/agency-mcp.test.ts packages/core/tests/overseer/agency-mcp-ledger.test.ts packages/core/src/roles/role-policy.test.ts
git commit -m "$(cat <<'EOF'
feat(core): ledger tools in the dispatch MCP and ledgerIds hand-offs (17 to 22 tools)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Batch line on every agent notice

**Files:**
- Create: `packages/core/src/sessions/batch-state.ts`
- Modify: `packages/core/src/sessions/service.ts` — imports (after the Task 2 import), `notifyCoordinatorOfAgent` (`:1070-1090`), its five callers (`:1131`, `:1151`, `:1185`, `:1292`, `:1315`), `startQueuedDependents` (`:1258-1265`), `noteAgentCompletion` (`:1275-1293`)
- Test: `packages/core/tests/sessions/batch-state.test.ts`, `packages/core/tests/sessions/notice-batch-line.test.ts`

**Interfaces:**
- Consumes: `ledgerDb.listOpenSeqs` (Task 1); `terminalsDb.listBySession` (`terminals.ts:104`, excludes archived rows); `SessionService.getPendingPermission(id)` (`service.ts:1438`).
- Produces:
  - `type NoticeKind = 'finished' | 'blocked' | 'question' | 'stopped' | 'direct-message'`
  - `interface AgentRef { id: string; label: string }`, `interface BatchState { working: AgentRef[]; queued: AgentRef[]; waiting: AgentRef[] }`, `interface BatchOptions { exclude?: readonly string[]; justStarted?: readonly string[] }`
  - `computeBatchState(db, sessionId, opts: BatchOptions, hasPending: (id: string) => boolean): BatchState`
  - `isBusy(state: BatchState): boolean`
  - `formatBatchFooter(state: BatchState, openSeqs: readonly number[]): string`
  - `SessionService.batchState(sessionId: string, opts?: BatchOptions): BatchState` (public; Task 8 uses it)
  - `notifyCoordinatorOfAgent(agentTerminalId, note, opts: { kind: NoticeKind; justStarted?: string[] }): boolean` (private)
  - `startQueuedDependents(finishedTerminalId): string[]` (private; returns the started ids)

- [ ] **Step 1: Write the failing tests**

`packages/core/tests/sessions/batch-state.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { computeBatchState, formatBatchFooter, isBusy } from '../../src/sessions/batch-state.js';

let db: Database.Database;

function agent(id: string, status: string, config: Record<string, unknown> = {}) {
  terminalsDb.create(db, { id, sessionId: 's1', type: 'claude-code', label: id.toUpperCase(), config: { role: 'agent', ...config } });
  terminalsDb.updateStatus(db, id, status);
}

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
});

describe('computeBatchState', () => {
  it('sorts agents into working, queued and waiting on the overseer', () => {
    agent('w', 'working');
    agent('s', 'scheduled');
    agent('q', 'queued');
    agent('n', 'needs_input');
    agent('p', 'working'); // working, but with a question pending to the overseer
    agent('i', 'waiting');
    agent('e', 'error');
    const state = computeBatchState(db, 's1', {}, (id) => id === 'p');
    expect(state.working.map((a) => a.id)).toEqual(['w', 's']);
    expect(state.queued.map((a) => a.id)).toEqual(['q']);
    expect(state.waiting.map((a) => a.id)).toEqual(['n', 'p']);
  });

  it('counts just-promoted dependents as working although they still read waiting', () => {
    agent('dep', 'waiting');
    expect(computeBatchState(db, 's1', { justStarted: ['dep'] }, () => false).working.map((a) => a.id)).toEqual(['dep']);
  });

  it('leaves out excluded ids, role runs, archived agents, the coordinator and plain threads', () => {
    agent('self', 'working');
    agent('role', 'working', { roleRun: 'nightly-check' });
    agent('gone', 'working');
    terminalsDb.archive(db, 'gone');
    terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'CP', config: { role: 'coordinator' } });
    terminalsDb.updateStatus(db, 'coord', 'working');
    terminalsDb.create(db, { id: 'plain', sessionId: 's1', type: 'claude-code', label: 'plain', config: {} });
    terminalsDb.updateStatus(db, 'plain', 'working');
    const state = computeBatchState(db, 's1', { exclude: ['self'] }, () => false);
    expect(state).toEqual({ working: [], queued: [], waiting: [] });
    expect(isBusy(state)).toBe(false);
  });
});

describe('formatBatchFooter — the spec texts, verbatim', () => {
  it('busy', () => {
    const state = { working: [{ id: 'b', label: 'Build X' }, { id: 'r', label: 'Review Y' }], queued: [{ id: 'q', label: 'Q' }], waiting: [] };
    expect(formatBatchFooter(state, [3, 7])).toBe(
      'Batch: still working — 2 agents ("Build X", "Review Y"); 1 queued.\n' +
      'Do not post a recap. If this needs a decision, add it with ledger_add\n' +
      'and post only that item. Otherwise write at most one line.\n' +
      'Open ledger items: N3, N7.',
    );
  });

  it('settled', () => {
    expect(formatBatchFooter({ working: [], queued: [], waiting: [] }, [3, 7])).toBe(
      'Batch: no other agent is working or queued.\n' +
      'If you start a next step now, write at most one line.\n' +
      'If you start nothing, the batch has settled: post the recap now\n' +
      '(ledger_list with forRecap, and list_agents).\n' +
      'Open ledger items: N3, N7.',
    );
  });

  it('names agents waiting on the overseer, and says "none" when no item is open', () => {
    const waiting = [{ id: 'p', label: 'Plan Z' }];
    expect(formatBatchFooter({ working: [{ id: 'b', label: 'Build X' }], queued: [], waiting }, []))
      .toBe('Batch: still working — 1 agent ("Build X"); 1 agent waiting on you ("Plan Z").\n' +
        'Do not post a recap. If this needs a decision, add it with ledger_add\n' +
        'and post only that item. Otherwise write at most one line.\n' +
        'Open ledger items: none.');
    expect(formatBatchFooter({ working: [], queued: [], waiting }, [])).toBe(
      'Batch: no other agent is working or queued.\n' +
      'Still 1 agent waiting on you ("Plan Z").\n' +
      'If you start a next step now, write at most one line.\n' +
      'If you start nothing, the batch has settled: post the recap now\n' +
      '(ledger_list with forRecap, and list_agents).\n' +
      'Open ledger items: none.');
  });
});
```

`packages/core/tests/sessions/notice-batch-line.test.ts`:

```ts
// Every agent notice ends with the Batch line (structured-recap spec, Unit 4).
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as ledgerDb from '../../src/db/ledger.js';
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

const BUSY = 'Batch: still working — 1 agent ("Build X").\n' +
  'Do not post a recap. If this needs a decision, add it with ledger_add\n' +
  'and post only that item. Otherwise write at most one line.\n' +
  'Open ledger items: N1.';
const SETTLED = 'Batch: no other agent is working or queued.\n' +
  'If you start a next step now, write at most one line.\n' +
  'If you start nothing, the batch has settled: post the recap now\n' +
  '(ledger_list with forRecap, and list_agents).\n' +
  'Open ledger items: N1.';

function makeService() {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  const svc = new SessionService(db, new NoopPty(), '/tmp/dispatch-batch-line-test-mcp.json');
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
  terminalsDb.create(db, { id: 'a', sessionId: 's1', type: 'claude-code', label: 'Subject', config: { role: 'agent', agentType: 'implementer' } });
  terminalsDb.create(db, { id: 'b', sessionId: 's1', type: 'claude-code', label: 'Build X', config: { role: 'agent', agentType: 'implementer' } });
  ledgerDb.create(db, { sessionId: 's1', kind: 'go', text: 'Merge PR #12.', author: 'overseer' });
  vi.spyOn(svc, 'ensureStructuredAlive').mockReturnValue(true);
  const sent = vi.spyOn(svc, 'sendStructuredMessage').mockImplementation(() => {});
  return { db, svc, sent };
}

const QUESTION = { toolName: 'AskUserQuestion', questions: [{ header: 'Fix', question: 'Stage the fix?', options: ['yes', 'no'] }] };

const fire = {
  finished: (svc: SessionService) => svc.noteAgentCompletion('a'),
  blocked: (svc: SessionService) => svc.noteAgentNeedsHelp('a', 'which branch?'),
  question: (svc: SessionService) => { svc.routeAgentQuestionToCoordinator('a', QUESTION); },
  stopped: (svc: SessionService) => svc.noteAgentLifecycle('a', 'stopped'),
};

describe('Batch line on agent notices', () => {
  for (const [kind, run] of Object.entries(fire)) {
    it(`${kind}: busy footer while another agent works, settled footer when none does`, () => {
      const { db, svc, sent } = makeService();
      terminalsDb.updateStatus(db, 'a', 'working'); // the subject itself never counts
      terminalsDb.updateStatus(db, 'b', 'working');
      run(svc);
      expect(sent.mock.calls[0][0]).toBe('coord');
      expect(String(sent.mock.calls[0][1]).endsWith(`\n\n${BUSY}`)).toBe(true);

      terminalsDb.updateStatus(db, 'b', 'waiting');
      run(svc);
      expect(String(sent.mock.calls[1][1]).endsWith(`\n\n${SETTLED}`)).toBe(true);
    });
  }

  it('direct message: the subject is about to work on the user\'s message, so the batch reads busy', () => {
    const { svc, sent } = makeService();
    svc.noteUserMessageToAgent('a', 'use the staging bucket');
    const text = String(sent.mock.calls[0][1]);
    expect(text.startsWith('💬 The user just sent your agent "Subject"')).toBe(true);
    expect(text).toContain('Batch: still working — 1 agent ("Subject").');
  });

  it('finished: a dependent promoted this instant counts as working although it reads waiting', () => {
    const { db, svc, sent } = makeService();
    terminalsDb.create(db, { id: 'dep', sessionId: 's1', type: 'claude-code', label: 'Review Y', config: { role: 'agent', dependsOn: 'a', queued: true, queuedTask: 'review' } });
    terminalsDb.updateStatus(db, 'dep', 'queued');
    vi.spyOn(svc, 'startQueuedTerminal').mockImplementation((id: string) => {
      terminalsDb.updateStatus(db, id, 'waiting');
      return svc.getTerminal(id);
    });
    svc.noteAgentCompletion('a');
    expect(String(sent.mock.calls[0][1])).toContain('Batch: still working — 1 agent ("Review Y").');
  });

  it('finished: the notice no longer says "or report back to the user"', () => {
    const { svc, sent } = makeService();
    svc.noteAgentCompletion('a');
    const text = String(sent.mock.calls[0][1]);
    expect(text).toContain('just finished a turn');
    expect(text).toContain('ingest the result, hand it to another agent, or spawn a follow-up.');
    expect(text).not.toContain('report back to the user');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run tests/sessions/batch-state.test.ts tests/sessions/notice-batch-line.test.ts`
Expected: FAIL. `batch-state.test.ts` reports `Failed to load url ../../src/sessions/batch-state.js`. The notice tests fail because no notice ends with a Batch line yet.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/sessions/batch-state.ts`:

```ts
/**
 * Settle facts for agent notices (structured-recap spec, Unit 4). A batch is SETTLED when none of
 * the overseer's agents is working or queued; the Batch line on every agent notice says which.
 */
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';

/** The five agent notices that carry the Batch line. */
export type NoticeKind = 'finished' | 'blocked' | 'question' | 'stopped' | 'direct-message';

export interface AgentRef { id: string; label: string }

export interface BatchState {
  /** working without a pending question, scheduled, or just started (justStarted). */
  working: AgentRef[];
  queued: AgentRef[];
  /** needs_input, or working with a question pending to the overseer. */
  waiting: AgentRef[];
}

export interface BatchOptions {
  /** Agents to leave out (the notice's own subject). */
  exclude?: readonly string[];
  /** Agents that count as working whatever their status reads (dependents promoted this instant). */
  justStarted?: readonly string[];
}

/**
 * Sort the project's agents (`config.role === 'agent'`, not archived, not a scheduled role run)
 * into working / queued / waiting on the overseer. `hasPending` says whether a terminal has a
 * pending question (the structured manager's getPending).
 */
export function computeBatchState(
  db: Database.Database,
  sessionId: string,
  opts: BatchOptions,
  hasPending: (terminalId: string) => boolean,
): BatchState {
  const exclude = new Set(opts.exclude ?? []);
  const justStarted = new Set(opts.justStarted ?? []);
  const state: BatchState = { working: [], queued: [], waiting: [] };
  for (const row of terminalsDb.listBySession(db, sessionId)) {
    if (exclude.has(row.id)) continue;
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(row.config || '{}'); } catch { /* default {} */ }
    if (cfg.role !== 'agent') continue;
    if (typeof cfg.roleRun === 'string' && cfg.roleRun) continue;
    const ref = { id: row.id, label: row.label || 'agent' };
    if (justStarted.has(row.id)) { state.working.push(ref); continue; }
    switch (row.status) {
      case 'working': (hasPending(row.id) ? state.waiting : state.working).push(ref); break;
      case 'scheduled': state.working.push(ref); break;
      case 'queued': state.queued.push(ref); break;
      case 'needs_input': state.waiting.push(ref); break;
      default: break; // waiting (idle/done), error: not part of the running batch
    }
  }
  return state;
}

/** Busy = an agent still works or is queued. Agents waiting on the overseer do not keep a batch busy. */
export function isBusy(state: BatchState): boolean {
  return state.working.length + state.queued.length > 0;
}

const agents = (n: number) => `${n} agent${n === 1 ? '' : 's'}`;
const labels = (refs: AgentRef[]) => refs.map((r) => `"${r.label}"`).join(', ');

/** The Batch line block appended (after a blank line) to every agent notice. Texts from the spec, verbatim. */
export function formatBatchFooter(state: BatchState, openSeqs: readonly number[]): string {
  const open = `Open ledger items: ${openSeqs.length ? openSeqs.map((s) => `N${s}`).join(', ') : 'none'}.`;
  const waiting = state.waiting.length ? `${agents(state.waiting.length)} waiting on you (${labels(state.waiting)})` : '';
  if (isBusy(state)) {
    const parts: string[] = [];
    if (state.working.length) parts.push(`${agents(state.working.length)} (${labels(state.working)})`);
    if (state.queued.length) parts.push(`${state.queued.length} queued`);
    if (waiting) parts.push(waiting);
    return [
      `Batch: still working — ${parts.join('; ')}.`,
      'Do not post a recap. If this needs a decision, add it with ledger_add',
      'and post only that item. Otherwise write at most one line.',
      open,
    ].join('\n');
  }
  return [
    'Batch: no other agent is working or queued.',
    ...(waiting ? [`Still ${waiting}.`] : []),
    'If you start a next step now, write at most one line.',
    'If you start nothing, the batch has settled: post the recap now',
    '(ledger_list with forRecap, and list_agents).',
    open,
  ].join('\n');
}
```

`packages/core/src/sessions/service.ts`:

After the Task 2 import line (`import * as coordinatorMessagesDb from '../db/coordinator-messages.js';`) add:

```ts
import * as ledgerDb from '../db/ledger.js';
import { computeBatchState, formatBatchFooter, type BatchOptions, type BatchState, type NoticeKind } from './batch-state.js';
```

In `notifyCoordinatorOfAgent`, replace the signature line:

```ts
  private notifyCoordinatorOfAgent(agentTerminalId: string, note: string): boolean {
```

with:

```ts
  private notifyCoordinatorOfAgent(agentTerminalId: string, note: string, opts: { kind: NoticeKind; justStarted?: string[] }): boolean {
```

and replace its tail:

```ts
    if (!coordinator) return false;
    try {
      this.ensureStructuredAlive(coordinator.id); // a daemon restart may have killed it
      this.sendStructuredMessage(coordinator.id, note);
      return true;
    } catch { return false; }
  }
```

with:

```ts
    if (!coordinator) return false;
    // The Batch line (structured-recap spec, Unit 4). A direct message starts the subject's
    // turn, so it counts as working; every other notice leaves its subject out.
    const batch = this.batchState(
      agent.session_id,
      opts.kind === 'direct-message'
        ? { justStarted: [...(opts.justStarted ?? []), agentTerminalId] }
        : { exclude: [agentTerminalId], justStarted: opts.justStarted },
    );
    const footer = formatBatchFooter(batch, ledgerDb.listOpenSeqs(this.db, agent.session_id));
    try {
      this.ensureStructuredAlive(coordinator.id); // a daemon restart may have killed it
      this.sendStructuredMessage(coordinator.id, `${note}\n\n${footer}`);
      return true;
    } catch { return false; }
  }

  /** The overseer's agents in this project, sorted into working / queued / waiting on the overseer. */
  batchState(sessionId: string, opts: BatchOptions = {}): BatchState {
    return computeBatchState(this.db, sessionId, opts, (id) => this.getPendingPermission(id) !== null);
  }
```

Update the four other callers:
- line 1131 (`routeAgentQuestionToCoordinator`): `return this.notifyCoordinatorOfAgent(agentTerminalId, note, { kind: 'question' });`
- line 1151 (`noteAgentLifecycle`): `this.notifyCoordinatorOfAgent(agentTerminalId, note, { kind: 'stopped' });`
- line 1185 (`noteUserMessageToAgent`): `this.notifyCoordinatorOfAgent(agentTerminalId, note, { kind: 'direct-message' });`
- line 1315 (`noteAgentNeedsHelp`): `this.notifyCoordinatorOfAgent(agentTerminalId, note, { kind: 'blocked' });`

Replace `startQueuedDependents` (lines 1258-1265) with:

```ts
  private startQueuedDependents(finishedTerminalId: string): string[] {
    const started: string[] = [];
    for (const dep of terminalsDb.listQueuedDependents(this.db, finishedTerminalId)) {
      let depConfig: Record<string, any> = {};
      try { depConfig = JSON.parse(dep.config || '{}'); } catch { /* default {} */ }
      const originalTask = typeof depConfig.queuedTask === 'string' ? depConfig.queuedTask : '';
      if (this.startQueuedTerminal(dep.id, this.composeDependentTask(finishedTerminalId, originalTask))) started.push(dep.id);
    }
    // Returned so the Finished notice counts them as working: they still read 'waiting' right now.
    return started;
  }
```

In `noteAgentCompletion`, replace line 1276:

```ts
    this.startQueuedDependents(agentTerminalId);
```

with:

```ts
    const started = this.startQueuedDependents(agentTerminalId);
```

and replace lines 1289-1292:

```ts
      `Read its full work with read_agent({ agentId: "${agentTerminalId}" }), then decide the next step — ` +
      `ingest the result, hand it to another agent, spawn a follow-up, or report back to the user. Keep this ` +
      `brief unless it needs action; the user's own messages are always your top priority.`;
    this.notifyCoordinatorOfAgent(agentTerminalId, note);
```

with:

```ts
      `Read its full work with read_agent({ agentId: "${agentTerminalId}" }), then decide the next step — ` +
      `ingest the result, hand it to another agent, or spawn a follow-up. Keep this ` +
      `brief unless it needs action; the user's own messages are always your top priority.`;
    this.notifyCoordinatorOfAgent(agentTerminalId, note, { kind: 'finished', justStarted: started });
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd packages/core && npx vitest run tests/sessions/batch-state.test.ts tests/sessions/notice-batch-line.test.ts tests/sessions/role-run-coordinator-notice.test.ts tests/routes/structured.test.ts`
Expected: PASS. `structured.test.ts` still finds `finished a turn`, `BLOCKED` and `waiting on you`, and still does not find `just finished a turn` on a blocked turn.

Run: `cd packages/core && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sessions/batch-state.ts packages/core/src/sessions/service.ts packages/core/tests/sessions/batch-state.test.ts packages/core/tests/sessions/notice-batch-line.test.ts
git commit -m "$(cat <<'EOF'
feat(core): every agent notice ends with a daemon Batch line

Just-promoted dependents count as working. The Finished notice no longer
invites a report to the user.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Interim recap after 20 minutes

**Files:**
- Create: `packages/core/src/sessions/interim-recap.ts`
- Modify: `packages/core/src/sessions/service.ts` — imports, `notifyCoordinatorOfAgent` tail (the block Task 7 wrote), two new methods
- Modify: `packages/core/src/server.ts:66` (import), `:831` (start), `:839` (cleanup)
- Test: `packages/core/tests/sessions/interim-recap.test.ts`

**Interfaces:**
- Consumes: `INTERIM_DUE_KEY` and `LedgerService` (Task 5); `BatchState`, `NoticeKind`, `isBusy`, `SessionService.batchState` (Task 7); `SessionService.clock` (Task 2).
- Produces:
  - `INTERIM_RECAP_MS = 20 * 60_000`
  - `formatInterimNotice(workingCount: number): string`
  - `nextInterimConfig(config, notice: { kind: NoticeKind; busy: boolean; now: number }): Record<string, any> | null`
  - `interimRecapTick(db, sessionService: Pick<SessionService, 'batchState' | 'sendInterimRecapNotice'>, now?: number): string[]`
  - `startInterimRecapLoop(db, sessionService, intervalMs = 60_000): NodeJS.Timeout`
  - `SessionService.sendInterimRecapNotice(coordinatorId: string, workingCount: number): boolean` (public)
  - `SessionService.updateInterimTimer(coordinatorId, kind, busy)` (private)

- [ ] **Step 1: Write the failing test**

`packages/core/tests/sessions/interim-recap.test.ts`:

```ts
// Interim recap after 20 minutes (structured-recap spec, Unit 5), with an injectable clock.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../../src/db/connection.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';
import { LedgerService } from '../../src/overseer/ledger-service.js';
import { formatInterimNotice, interimRecapTick, nextInterimConfig, INTERIM_RECAP_MS } from '../../src/sessions/interim-recap.js';

class NoopPty extends PTYManager {
  override spawn(): number { return 1; }
  override write(): void {}
  override resize(): void {}
  override kill(): void {}
  override getBuffer(): string { return ''; }
  override isAlive(): boolean { return false; }
  override killAll(): void {}
}

const T0 = Date.parse('2026-10-05T16:00:00.000Z');
const DUE = new Date(T0 + INTERIM_RECAP_MS).toISOString();
let dir: string;
let dbPath: string;

function open(): { db: Database.Database; svc: SessionService; sent: ReturnType<typeof vi.fn> } {
  const db = createDatabase(dbPath);
  const svc = new SessionService(db, new NoopPty(), path.join(dir, 'mcp.json'));
  vi.spyOn(svc, 'ensureStructuredAlive').mockReturnValue(true);
  const sent = vi.spyOn(svc, 'sendStructuredMessage').mockImplementation(() => {}) as unknown as ReturnType<typeof vi.fn>;
  svc.clock = () => T0;
  return { db, svc, sent };
}
const due = (db: Database.Database) => JSON.parse(terminalsDb.getById(db, 'coord')!.config!).interimDueAt;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-interim-'));
  dbPath = path.join(dir, 'dispatch.db');
  const db = createDatabase(dbPath);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: dir });
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
  terminalsDb.create(db, { id: 'a', sessionId: 's1', type: 'claude-code', label: 'A', config: { role: 'agent' } });
  terminalsDb.create(db, { id: 'b', sessionId: 's1', type: 'claude-code', label: 'B', config: { role: 'agent' } });
  terminalsDb.updateStatus(db, 'b', 'working');
  db.close();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('formatInterimNotice', () => {
  it('is the spec text, verbatim', () => {
    expect(formatInterimNotice(2)).toBe(
      '🕒 Interim recap due: agent turns finished 20 minutes ago, and 2 agents\n' +
      'still work. Post the recap now and mark it "interim". Then keep holding.',
    );
  });
});

describe('nextInterimConfig', () => {
  it('arms only on a busy Finished notice with no timer running', () => {
    expect(nextInterimConfig({ role: 'coordinator' }, { kind: 'finished', busy: true, now: T0 })).toEqual({ role: 'coordinator', interimDueAt: DUE });
    expect(nextInterimConfig({ interimDueAt: DUE }, { kind: 'finished', busy: true, now: T0 + 60_000 })).toBeNull();
    expect(nextInterimConfig({}, { kind: 'blocked', busy: true, now: T0 })).toBeNull();
  });
  it('clears on any settled notice', () => {
    expect(nextInterimConfig({ role: 'coordinator', interimDueAt: DUE }, { kind: 'question', busy: false, now: T0 })).toEqual({ role: 'coordinator' });
    expect(nextInterimConfig({}, { kind: 'finished', busy: false, now: T0 })).toBeNull();
  });
});

describe('interim recap timer', () => {
  it('arms once, on a busy Finished notice', () => {
    const { db, svc } = open();
    svc.noteAgentCompletion('a');
    expect(due(db)).toBe(DUE);
    svc.clock = () => T0 + 5 * 60_000;
    svc.noteAgentCompletion('a');
    expect(due(db)).toBe(DUE); // not re-armed
  });

  it('clears on a settled notice', () => {
    const { db, svc } = open();
    svc.noteAgentCompletion('a');
    terminalsDb.updateStatus(db, 'b', 'waiting');
    svc.noteAgentCompletion('b');
    expect(due(db)).toBeUndefined();
  });

  it('clears on ledger_list with forRecap', () => {
    const { db, svc } = open();
    svc.noteAgentCompletion('a');
    new LedgerService(db).list('s1', 'coord', { forRecap: true });
    expect(due(db)).toBeUndefined();
  });

  it('fires once at the due time, while agents still work', () => {
    const { db, svc, sent } = open();
    svc.noteAgentCompletion('a');
    sent.mockClear();
    expect(interimRecapTick(db, svc, T0 + INTERIM_RECAP_MS - 1)).toEqual([]);
    expect(interimRecapTick(db, svc, T0 + INTERIM_RECAP_MS)).toEqual(['coord']);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]).toEqual(['coord', formatInterimNotice(1)]);
    expect(due(db)).toBeUndefined();
    expect(interimRecapTick(db, svc, T0 + INTERIM_RECAP_MS + 60_000)).toEqual([]);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('does not fire when nothing works at the due time, and clears the timer', () => {
    const { db, svc, sent } = open();
    svc.noteAgentCompletion('a');
    sent.mockClear();
    terminalsDb.updateStatus(db, 'b', 'waiting');
    expect(interimRecapTick(db, svc, T0 + INTERIM_RECAP_MS)).toEqual([]);
    expect(sent).not.toHaveBeenCalled();
    expect(due(db)).toBeUndefined();
  });

  it('survives a daemon restart: the due time is in the database', () => {
    const first = open();
    first.svc.noteAgentCompletion('a');
    first.db.close();

    const second = open(); // a new process: new connection, new service
    expect(interimRecapTick(second.db, second.svc, T0 + INTERIM_RECAP_MS)).toEqual(['coord']);
    expect(second.sent).toHaveBeenCalledWith('coord', formatInterimNotice(1));
    second.db.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx vitest run tests/sessions/interim-recap.test.ts`
Expected: FAIL — `Failed to load url ../../src/sessions/interim-recap.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/sessions/interim-recap.ts`:

```ts
/**
 * Interim recap after 20 minutes (structured-recap spec, Unit 5).
 *
 * Start: a Finished notice goes out while agents still work and no timer runs →
 *        `interimDueAt = now + 20 min` on the overseer's terminal config.
 * Stop:  a settled notice, or ledger_list({ forRecap: true }) (ledger-service.ts), clears it.
 * Check: a 60-second sweep (the auto-archive pattern). The due time lives in the database, so
 *        a daemon restart keeps it.
 * Fire:  at the due time, if agents still work, one Interim recap notice; the timer clears
 *        either way, so it fires once.
 */
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import { INTERIM_DUE_KEY } from '../overseer/ledger-service.js';
import type { BatchState, NoticeKind } from './batch-state.js';
import type { SessionService } from './service.js';

export const INTERIM_RECAP_MS = 20 * 60_000;
const DEFAULT_INTERVAL_MS = 60_000;

/** The Interim recap notice. Its 🕒 prefix differs from every other notice prefix. */
export function formatInterimNotice(workingCount: number): string {
  const n = workingCount;
  return (
    `🕒 Interim recap due: agent turns finished ${INTERIM_RECAP_MS / 60_000} minutes ago, and ${n} agent${n === 1 ? '' : 's'}\n` +
    `still work${n === 1 ? 's' : ''}. Post the recap now and mark it "interim". Then keep holding.`
  );
}

/**
 * The overseer config after a notice, or null when it does not change. Pure.
 *  - settled (not busy)                         → clear the timer
 *  - busy Finished notice with no timer running → arm it at now + 20 min
 *  - anything else                              → unchanged
 */
export function nextInterimConfig(
  config: Record<string, any>,
  notice: { kind: NoticeKind; busy: boolean; now: number },
): Record<string, any> | null {
  const armed = typeof config[INTERIM_DUE_KEY] === 'string';
  if (!notice.busy) {
    if (!armed) return null;
    const next = { ...config };
    delete next[INTERIM_DUE_KEY];
    return next;
  }
  if (notice.kind === 'finished' && !armed) {
    return { ...config, [INTERIM_DUE_KEY]: new Date(notice.now + INTERIM_RECAP_MS).toISOString() };
  }
  return null;
}

/** One sweep pass (exported for tests — no timers involved). Returns the overseers it notified. */
export function interimRecapTick(
  db: Database.Database,
  sessionService: Pick<SessionService, 'batchState' | 'sendInterimRecapNotice'>,
  now: number = Date.now(),
): string[] {
  const fired: string[] = [];
  let rows: terminalsDb.TerminalRow[];
  try {
    rows = db.prepare('SELECT * FROM terminals WHERE archived_at IS NULL').all() as terminalsDb.TerminalRow[];
  } catch (err) {
    console.error('interim recap: sweep query failed (DB may be closing)', err);
    return fired;
  }
  for (const row of rows) {
    try {
      const cfg = terminalsDb.rowToTerminal(row).config;
      if (cfg.role !== 'coordinator' || typeof cfg[INTERIM_DUE_KEY] !== 'string') continue;
      const due = Date.parse(cfg[INTERIM_DUE_KEY]);
      if (Number.isFinite(due) && now < due) continue;
      // Clear first: the timer fires once, even if the send below fails.
      const next = { ...cfg };
      delete next[INTERIM_DUE_KEY];
      terminalsDb.updateConfig(db, row.id, next);
      const state: BatchState = sessionService.batchState(row.session_id);
      if (state.working.length > 0 && sessionService.sendInterimRecapNotice(row.id, state.working.length)) fired.push(row.id);
    } catch (err) {
      console.error(`interim recap: failed for terminal ${row.id}`, err);
    }
  }
  return fired;
}

/** Start the sweep loop. Returns the interval id for cleanup. */
export function startInterimRecapLoop(
  db: Database.Database,
  sessionService: SessionService,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): NodeJS.Timeout {
  return setInterval(() => {
    try {
      interimRecapTick(db, sessionService);
    } catch (err) {
      console.error('interim recap sweep failed', err);
    }
  }, intervalMs);
}
```

`packages/core/src/sessions/service.ts` — replace the Task 7 batch-state import line:

```ts
import { computeBatchState, formatBatchFooter, type BatchOptions, type BatchState, type NoticeKind } from './batch-state.js';
```

with:

```ts
import { computeBatchState, formatBatchFooter, isBusy, type BatchOptions, type BatchState, type NoticeKind } from './batch-state.js';
import { formatInterimNotice, nextInterimConfig } from './interim-recap.js';
```

In `notifyCoordinatorOfAgent`, replace the send block that Task 7 wrote:

```ts
    try {
      this.ensureStructuredAlive(coordinator.id); // a daemon restart may have killed it
      this.sendStructuredMessage(coordinator.id, `${note}\n\n${footer}`);
      return true;
    } catch { return false; }
  }
```

with:

```ts
    try {
      this.ensureStructuredAlive(coordinator.id); // a daemon restart may have killed it
      this.sendStructuredMessage(coordinator.id, `${note}\n\n${footer}`);
    } catch { return false; }
    this.updateInterimTimer(coordinator.id, opts.kind, isBusy(batch));
    return true;
  }

  /** Arm or clear the overseer's interim recap timer after a notice (see sessions/interim-recap.ts). */
  private updateInterimTimer(coordinatorId: string, kind: NoticeKind, busy: boolean): void {
    try {
      const row = terminalsDb.getById(this.db, coordinatorId);
      if (!row) return;
      let cfg: Record<string, any> = {};
      try { cfg = JSON.parse(row.config || '{}'); } catch { /* default {} */ }
      const next = nextInterimConfig(cfg, { kind, busy, now: this.clock() });
      if (next) terminalsDb.updateConfig(this.db, coordinatorId, next);
    } catch (err) {
      console.error(`interim recap: timer update failed for ${coordinatorId}`, err);
    }
  }

  /** Send the one Interim recap notice. Revives the overseer first, as notices do. */
  sendInterimRecapNotice(coordinatorId: string, workingCount: number): boolean {
    try {
      this.ensureStructuredAlive(coordinatorId);
      this.sendStructuredMessage(coordinatorId, formatInterimNotice(workingCount));
      return true;
    } catch { return false; }
  }
```

`packages/core/src/server.ts` — after line 66 (`import { startAutoArchiveLoop } from './sessions/auto-archive.js';`) add:

```ts
import { startInterimRecapLoop } from './sessions/interim-recap.js';
```

After line 831 (`const autoArchiveInterval = startAutoArchiveLoop(db, sessionService, broadcaster);`) add:

```ts
  // Interim recap sweep (structured-recap spec, Unit 5): one notice to an overseer whose
  // agents still work 20 minutes after a busy Finished notice. The due time is in the DB.
  const interimRecapInterval = startInterimRecapLoop(db, sessionService);
```

After line 839 (`clearInterval(autoArchiveInterval);`) add:

```ts
    clearInterval(interimRecapInterval);
```

The loop is started only in `startServer`, like the auto-archive sweep; `createApp` (tests) does not start it.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd packages/core && npx vitest run tests/sessions/interim-recap.test.ts tests/sessions/notice-batch-line.test.ts tests/overseer/ledger-service.test.ts`
Expected: PASS (9 new tests).

Run: `cd packages/core && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sessions/interim-recap.ts packages/core/src/sessions/service.ts packages/core/src/server.ts packages/core/tests/sessions/interim-recap.test.ts
git commit -m "$(cat <<'EOF'
feat(core): interim recap notice after 20 minutes of a busy batch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Persona contract

**Files:**
- Modify: `packages/core/src/overseer/prompts.ts:24, 35, 45, 47` (tool list), `:76-82` (WATCH paragraph)
- Modify: `packages/core/src/overseer/prompts.coordinator.test.ts:54-55, 61`
- Test: `packages/core/src/overseer/prompts.recap.test.ts`

**Interfaces:**
- Consumes: the tool names from Task 6 and the notice texts from Tasks 7 and 8.
- Produces: the new `COORDINATOR_PROMPT` text. `buildCoordinatorPrompt({ harness: 'claude-code' })` stays byte-identical to `COORDINATOR_PROMPT`. The Codex variant keeps all six replacements.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/overseer/prompts.recap.test.ts`:

```ts
// The persona contract for structured recaps and the decision ledger (structured-recap spec, Unit 6).
import { describe, expect, it } from 'vitest';
import { buildCoordinatorPrompt } from './prompts.js';

const CONTRACT = [
  'ends with a Batch line from the daemon. Follow it',
  'do not post a recap — write at most one line',
  'Call read_agent ONCE when you need an agent’s content to act',
  'REPORTING: report to the user in one recap per settled batch, not one reply per agent turn.',
  '"🕒 Interim recap due"',
  'when the user says "recap" — that word means: post this format now.',
  'at most about 25 lines',
  '1. A header: <project> · <time> · <n> decisions, <n> tests, <n> agents working',
  '2. Needs you now — paste from ledger_list.',
  '3. Your tests and actions — paste from ledger_list.',
  '4. Running — from list_agents, with what happens when each finishes.',
  '5. Done since the last recap',
  'No evidence sections; give the evidence only when the user asks.',
  '6. Parked — paste from ledger_list.',
  'never write "your rule", "you decided", "you said" or "you approved" except when you paste a ledger line that has a quote.',
  'A "yes" approves only the item text.',
  'A message that starts with "ok" does not agree with, answer or approve anything by that word',
  '"ok" never authorizes a merge, a push to a protected branch, a release or a deploy.',
  'Pass ledgerIds to agents; do not restate the user’s decisions in your own words as the owner’s rule.',
  'Every question to the user goes into the ledger first',
  'Do not save a proposal as a standing rule in memory before the user approves it. When you save a rule, include the user’s quote.',
  'After 3 days with no answer, ask once whether to keep or park an item.',
  'If your context starts with a continuation summary, call ledger_list before you answer.',
  'End each turn with report_status: needs_you when open go or decide items exist, otherwise done.',
];

describe('coordinator persona — structured recap contract', () => {
  for (const harness of ['claude-code', 'codex']) {
    it(`${harness}: carries every contract line and drops "synthesize and report to the user"`, () => {
      const p = buildCoordinatorPrompt({ harness });
      for (const line of CONTRACT) expect(p, line).toContain(line);
      expect(p).not.toContain('synthesize and report to the user');
      for (const tool of ['ledger_add(', 'ledger_resolve(', 'ledger_note(', 'ledger_list(', 'ledger_import(']) expect(p).toContain(tool);
    });
  }
});
```

In `packages/core/src/overseer/prompts.coordinator.test.ts`, replace lines 54-55:

```ts
      expect(p).toContain('spawn_agent({ agentType, name?, task, mission?, model?, harness? })');
      expect(p).toContain('queue_agent({ agentType, name?, task, mission?, dependsOn?, model?, harness? })');
```

with:

```ts
      expect(p).toContain('spawn_agent({ agentType, name?, task, mission?, model?, harness?, ledgerIds? })');
      expect(p).toContain('queue_agent({ agentType, name?, task, mission?, dependsOn?, model?, harness?, ledgerIds? })');
      expect(p).toContain('message_agent({ agentId, text, ledgerIds? })');
```

and insert before line 61 (`it('an unrecognized harness falls back to the claude-code variant', () => {`):

```ts
  // The codex variant is built with indexOf/replace on these exact strings. If an edit to
  // COORDINATOR_PROMPT drops one, the codex replacement silently stops happening.
  it('every string the codex variant replaces is still in COORDINATOR_PROMPT', () => {
    for (const marker of [
      'Each type defaults to a sensible model tier ',
      'only to override that default when a task is unusually easy or hard for its role.\n',
      'MODEL ECONOMY: the per-type default model is often too big for the task. ',
      'status checks and "did last night',
      'the opus defaults for genuine investigation, planning, and judgment.',
      'when you hit a denial, spawn the right agent instead of retrying.\n\n',
    ]) {
      expect(COORDINATOR_PROMPT, marker).toContain(marker);
    }
  });

  it('the codex variant differs from the claude variant at every replacement', () => {
    const p = buildCoordinatorPrompt({ harness: 'codex' });
    expect(p).not.toContain('Each type defaults to a sensible model tier ');
    expect(p).toContain('Each agent type has a sensible default model');
    expect(p).toContain("Pass `model` with a smaller/cheaper model id appropriate to the worker's harness when you spawn: status checks");
    expect(p).not.toContain('the opus defaults for genuine investigation');
    expect(p).toContain('the stronger default models for genuine investigation, planning, and judgment.');
    expect(p).toContain('spawn the right agent instead of retrying. On this harness specifically:');
  });

```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run src/overseer/prompts.recap.test.ts src/overseer/prompts.coordinator.test.ts`
Expected: FAIL. Every contract line is missing; the signature pins do not find `ledgerIds?`. The two marker tests pass at once: they guard the six strings during the edit below and must still pass after it.

- [ ] **Step 3: Write the implementation**

All edits are in `packages/core/src/overseer/prompts.ts`.

Line 24 — replace:

```ts
  '- spawn_agent({ agentType, name?, task, mission?, model?, harness? }) — create a typed agent thread and seed it with a task. ' +
```

with:

```ts
  '- spawn_agent({ agentType, name?, task, mission?, model?, harness?, ledgerIds? }) — create a typed agent thread and seed it with a task. ' +
```

Line 35 — replace:

```ts
  '- queue_agent({ agentType, name?, task, mission?, dependsOn?, model?, harness? }) — like spawn_agent but QUEUED: ' +
```

with:

```ts
  '- queue_agent({ agentType, name?, task, mission?, dependsOn?, model?, harness?, ledgerIds? }) — like spawn_agent but QUEUED: ' +
```

Line 45 — replace:

```ts
  '- message_agent({ agentId, text }) — steer or correct an existing agent.\n' +
```

with:

```ts
  '- message_agent({ agentId, text, ledgerIds? }) — steer or correct an existing agent. On spawn_agent, ' +
  'queue_agent and message_agent, `ledgerIds` (e.g. ["N7"]) appends the user’s decisions verbatim from the ledger.\n' +
```

Line 47 — replace:

```ts
  '- complete_agent({ agentId }) — archive an agent when its work is done.\n\n' +
```

with:

```ts
  '- complete_agent({ agentId }) — archive an agent when its work is done.\n' +
  '- ledger_add({ kind, text, recommendation?, options?, blocks?, mission?, author?, supersedes? }) — record a go ' +
  '(merge/deploy/release approval), decide (a choice) or do (a manual step for the user) item; returns its ID and ' +
  'the line to post as is.\n' +
  '- ledger_resolve({ id, status, quote?, reading?, reason? }) — close an item: answered or parked with the ' +
  'user’s exact words as quote (the daemon checks them), or withdrawn with a reason.\n' +
  '- ledger_note({ quote, reading?, mission? }) — record a statement the user made, with their exact words.\n' +
  '- ledger_list({ forRecap? }) — the ledger part of a recap; forRecap: true marks the recap as posted.\n' +
  '- ledger_import({ items }) — once, at rollout: load open items and earlier decisions from your context.\n\n' +
```

Lines 76-82 (the WATCH paragraph) — replace:

```ts
  '- WATCH your agents — never fire-and-forget. The instant an agent finishes a turn you receive a ' +
  '"✅ … finished a turn" notice with a short summary. Act on it: call read_agent ONCE to ingest its ' +
  'full output, then decide the next step — synthesize and report to the user, hand the result to ' +
  'another agent, spawn a follow-up, or complete_agent if it’s done. Do not re-read an agent that has ' +
  'not finished another turn since your last read — repeated read_agent calls on an unchanged agent ' +
  'are pure token burn. A researcher’s whole purpose is to inform you, so always read_agent a ' +
  'finished researcher before moving on.\n' +
```

with:

```ts
  '- WATCH your agents — never fire-and-forget. Every agent notice (✅ finished, ⏸️ blocked, 🔔 question, ' +
  '⚠️ stopped, 💬 direct message) ends with a Batch line from the daemon. Follow it: while agents still ' +
  'work, do not post a recap — write at most one line, or add the decision with ledger_add and post only ' +
  'that item. Call read_agent ONCE when you need an agent’s content to act, then hand the result to ' +
  'another agent, spawn a follow-up, or complete_agent if it’s done. Do not re-read an agent that has ' +
  'not finished another turn since your last read — repeated read_agent calls on an unchanged agent ' +
  'are pure token burn. A researcher’s whole purpose is to inform you, so always read_agent a ' +
  'finished researcher before moving on.\n' +
  '- REPORTING: report to the user in one recap per settled batch, not one reply per agent turn. Post ' +
  'the recap when the Batch line says the batch has settled, when an "🕒 Interim recap due" notice ' +
  'arrives (mark that recap "interim"), or when the user says "recap" — that word means: post this ' +
  'format now. Build it with ledger_list({ forRecap: true }) and list_agents. The recap format, in this ' +
  'order, at most about 25 lines:\n' +
  '  1. A header: <project> · <time> · <n> decisions, <n> tests, <n> agents working\n' +
  '  2. Needs you now — paste from ledger_list.\n' +
  '  3. Your tests and actions — paste from ledger_list.\n' +
  '  4. Running — from list_agents, with what happens when each finishes.\n' +
  '  5. Done since the last recap — paste the "Decided since the last recap" lines from ledger_list, ' +
  'then one line per finished piece of work, with PR numbers and links. No evidence sections; give the ' +
  'evidence only when the user asks.\n' +
  '  6. Parked — paste from ledger_list.\n' +
  '- PROVENANCE: never write "your rule", "you decided", "you said" or "you approved" except when you ' +
  'paste a ledger line that has a quote. A "yes" approves only the item text. A message that starts ' +
  'with "ok" does not agree with, answer or approve anything by that word: read only the words after ' +
  'it, and use them only if they answer the item. "ok" never authorizes a merge, a push to a protected ' +
  'branch, a release or a deploy. A wider use of a decision is a new ledger item (supersedes) or a ' +
  'reading ("I read this as: …"). Pass ledgerIds to agents; do not restate the user’s decisions in your ' +
  'own words as the owner’s rule.\n' +
  '- Every question to the user goes into the ledger first: call ledger_add, then post the line it ' +
  'returns, as is. When the user states a rule or a preference, record it with ledger_note and their ' +
  'exact words.\n' +
  '- Do not save a proposal as a standing rule in memory before the user approves it. When you save a ' +
  'rule, include the user’s quote.\n' +
  '- After 3 days with no answer, ask once whether to keep or park an item.\n' +
  '- If your context starts with a continuation summary, call ledger_list before you answer.\n' +
  '- End each turn with report_status: needs_you when open go or decide items exist, otherwise done.\n' +
```

Use the curly apostrophe (’) in the new text, as the rest of the file does; the contract test matches it exactly.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd packages/core && npx vitest run src/overseer/ tests/overseer/prompts.test.ts tests/sessions/agency-mcp-injection.test.ts`
Expected: PASS. This includes the claude variant === `COORDINATOR_PROMPT` pin, the Codex "no sonnet/opus/fable/haiku" test, `read_agent ONCE`, `BE CONCISE`, `answer_agent`, `MODEL ECONOMY`, and the injection test at `tests/sessions/agency-mcp-injection.test.ts:108`.

Run: `cd packages/core && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/overseer/prompts.ts packages/core/src/overseer/prompts.coordinator.test.ts packages/core/src/overseer/prompts.recap.test.ts
git commit -m "$(cat <<'EOF'
feat(core): overseer persona — Batch line, recap format, provenance rules

Adds a test that fails when a Codex-variant marker string goes missing.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Web stream — Blocked and Interim recap notices

**Files:**
- Modify: `packages/web/src/components/overseer/components/Stream.tsx:26` (icons), `:210-217` (template comment), `:256-262` (`detectAgencyNotice`)
- Test: `packages/web/src/components/overseer/components/StreamAgencyNotices.test.tsx`

**Interfaces:**
- Consumes: the notice texts from Tasks 7 and 8 (detection keys on the leading emoji and a phrase only, so the appended Batch block never changes the type).
- Produces: two new `detectAgencyNotice` branches. Blocked: `PauseCircle`, `var(--yellow)`, summary `Agent "<name>" is blocked, waiting on you`. Interim: `Clock`, `var(--acc)`, summary `Interim recap due`, `agentId: null`.

- [ ] **Step 1: Write the failing test**

`packages/web/src/components/overseer/components/StreamAgencyNotices.test.tsx`:

```tsx
// Every daemon notice to the overseer renders as a muted system pill (or the 💬 card), never as a
// raw "You" bubble — including the Batch block the daemon appends to the five agent notices.
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { m } from '../data';
import { useOverseer } from '../store';
import { useProjects } from '../../../stores/projects';
import { ConversationStream } from './Stream';

beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
  Element.prototype.scrollTo = Element.prototype.scrollTo || (() => {});
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
});

beforeEach(() => {
  useProjects.setState({ activeId: 'proj-1' });
  useOverseer.setState({
    coordinatorId: 'coord-1',
    coordinatorProject: 'proj-1',
    coordinatorStream: [],
    coordinatorBusy: false,
    coordinatorPending: null,
    coordinatorAnswer: () => {},
  });
});

afterEach(cleanup);

const BATCH =
  '\n\nBatch: still working — 1 agent ("Review Y").\n' +
  'Do not post a recap. If this needs a decision, add it with ledger_add\n' +
  'and post only that item. Otherwise write at most one line.\n' +
  'Open ledger items: N3.';

// Mirrors the templates in packages/core/src/sessions/service.ts and sessions/interim-recap.ts.
const NOTICES: Array<[string, string, string]> = [
  ['finished', '✅ Your agent "Bob" (mission "Fix auth") [agentId term-1] just finished a turn.\nIts latest output: done\n\nRead its full work with read_agent({ agentId: "term-1" }), then decide the next step.' + BATCH, 'Agent "Bob" finished'],
  ['blocked', '⏸️ Your agent "Bob" (mission "Fix auth") [agentId term-1] is BLOCKED, waiting on you — it stopped its turn to ask:\n"Which branch?"\n\nIt cannot proceed until you reply.' + BATCH, 'Agent "Bob" is blocked, waiting on you'],
  ['question', '🔔 Your agent "Bob" (mission "Fix auth") is PAUSED waiting on you to answer a question (it cannot proceed until you do):\n  • [Fix] Stage the fix?\n\nanswer_agent({ agentId: "term-1", answers: { "Fix": "<chosen option>" } })' + BATCH, 'Agent "Bob" needs an answer'],
  ['stopped', '⚠️ The user just stopped your agent "Bob" (mission "Fix auth") [agentId term-1] while it was working. Do not silently ignore this.' + BATCH, 'You stopped agent "Bob"'],
  ['interim', '🕒 Interim recap due: agent turns finished 20 minutes ago, and 2 agents\nstill work. Post the recap now and mark it "interim". Then keep holding.', 'Interim recap due'],
];

describe('ConversationStream — agency notices with the Batch block', () => {
  for (const [kind, text, summary] of NOTICES) {
    it(`${kind}: renders the one-line pill, not a raw bubble`, () => {
      useOverseer.setState({ coordinatorStream: [m('user', 'You', text, '9:02', 0)] });
      render(<ConversationStream />);
      expect(screen.getByText(summary)).toBeInTheDocument();
      expect(screen.queryByText(/Batch:/)).not.toBeInTheDocument();
      expect(screen.queryByText('You')).not.toBeInTheDocument();
    });
  }

  it('direct message: still the card, with the Batch block appended', () => {
    const text = '💬 The user just sent your agent "Bob" (mission "Fix auth") [agentId term-1] a message directly, not through you: "use staging". This may change what you asked it to do. Read how it responds with read_agent and adjust.' + BATCH;
    useOverseer.setState({ coordinatorStream: [m('user', 'You', text, '9:02', 0)] });
    render(<ConversationStream />);
    expect(screen.getByText('Direct message to "Bob"')).toBeInTheDocument();
    expect(screen.getByText('“use staging”')).toBeInTheDocument();
  });

  it('a real user message that starts with one of the emoji stays a "You" bubble', () => {
    useOverseer.setState({ coordinatorStream: [m('user', 'You', '⏸️ pause the deploy for now', '9:02', 0)] });
    render(<ConversationStream />);
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('⏸️ pause the deploy for now')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/overseer/components/StreamAgencyNotices.test.tsx`
Expected: FAIL on `blocked` and `interim`: `Unable to find an element with the text: Agent "Bob" is blocked, waiting on you` and `… Interim recap due` (both fall through to a "You" bubble). The finished, question, stopped and direct-message cases pass already; they are the coverage the spec asks for.

- [ ] **Step 3: Write the implementation**

In `packages/web/src/components/overseer/components/Stream.tsx`, replace line 26:

```tsx
import { Bell, CaretDoubleDown, ChatTeardropText, CheckCircle, WarningCircle } from '@phosphor-icons/react';
```

with:

```tsx
import { Bell, CaretDoubleDown, ChatTeardropText, CheckCircle, Clock, PauseCircle, WarningCircle } from '@phosphor-icons/react';
```

Replace the template comment lines 212-214:

```tsx
//   ✅ Your agent "<label>" […] just finished a turn.…             (noteAgentCompletion)
//   🔔 Your agent "<label>" […] is PAUSED waiting on you …         (formatAgentQuestion)
//   ⚠️ The user just <stopped|interrupted> your agent "<label>" …  (noteAgentLifecycle)
```

with:

```tsx
//   ✅ Your agent "<label>" […] just finished a turn.…             (noteAgentCompletion)
//   ⏸️ Your agent "<label>" […] is BLOCKED, waiting on you …       (noteAgentNeedsHelp)
//   🔔 Your agent "<label>" […] is PAUSED waiting on you …         (formatAgentQuestion)
//   ⚠️ The user just <stopped|interrupted> your agent "<label>" …  (noteAgentLifecycle)
//   🕒 Interim recap due: agent turns finished 20 minutes ago, …   (sessions/interim-recap.ts)
// The five agent notices end with a daemon "Batch:" block; detection keys on the start only.
```

In `detectAgencyNotice`, insert between the `✅` branch (ends line 259) and the `// 🔔 paused / waiting on an answer` comment (line 260):

```tsx
  // ⏸️ blocked — the agent stopped its turn to ask (match the base ⏸ codepoint; the source
  // carries a trailing VS16). Before this branch it fell through to a raw "You" bubble.
  if (t.startsWith('⏸') && /your agent|is BLOCKED/i.test(t)) {
    return { icon: PauseCircle, color: 'var(--yellow)', summary: name ? `Agent "${name}" is blocked, waiting on you` : 'Agent is blocked, waiting on you', agentId };
  }
  // 🕒 interim recap due — no agent subject (its only quoted word is "interim")
  if (t.startsWith('🕒') && /interim recap due/i.test(t)) {
    return { icon: Clock, color: 'var(--acc)', summary: 'Interim recap due', agentId: null };
  }
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd packages/web && npx vitest run src/components/overseer/components/`
Expected: PASS (all Stream, direct-message and notice tests).

Run: `cd packages/web && npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/overseer/components/Stream.tsx packages/web/src/components/overseer/components/StreamAgencyNotices.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): show Blocked and Interim recap notices as pills; test all six notice types

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: End-to-end check with the fake CLI

**Files:**
- Test: `packages/core/tests/routes/overseer-ledger-e2e.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-8 through the real app: `createApp({ db, skipPty, secretsDir, structuredCommand })` (`server.ts:297`), the fake CLI `packages/core/tests/structured/fake-claude.mjs` (it echoes `echo:<text>` and ends the turn).
- Produces: no production code. This task pins the wiring end to end, as the spec's Tests section asks.

- [ ] **Step 1: Write the test**

`packages/core/tests/routes/overseer-ledger-e2e.test.ts`:

```ts
// End to end (fake CLI, as in structured.test.ts): the overseer message log and the decision
// ledger through the real routes, managers, and notice path.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import * as messagesDb from '../../src/db/coordinator-messages.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), '../structured/fake-claude.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let app: any;
let db: Database.Database;
let dir: string;
let cfgDir: string;
let sid: string;
let coordId: string;
let agentId: string;

async function until(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await sleep(25);
  }
  throw new Error('timeout waiting for condition');
}

beforeEach(async () => {
  db = new Database(':memory:');
  initSchema(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-e2e-'));
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-e2e-cfg-')); // never the real ~/.dispatch
  app = createApp({ db, skipPty: true, secretsDir: cfgDir, structuredCommand: { command: process.execPath, args: [fake] } });
  sid = (await request(app).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 'ledger-e2e' })).body.id;
  coordId = (await request(app).post(`/api/sessions/${sid}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', role: 'coordinator' } })).body.id;
  agentId = (await request(app).post(`/api/sessions/${sid}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', agentType: 'researcher', role: 'agent', mission: 'Repo map' } })).body.id;
  await until(() => (db.prepare('SELECT external_id FROM terminals WHERE id = ?').get(coordId) as { external_id: string | null }).external_id === 'sess-fake');
});

afterEach(() => {
  app?._structuredManager?.killAll?.();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

describe('overseer ledger — end to end', () => {
  it('a human send is logged as user, and an agent notice as daemon with the Batch line', async () => {
    await request(app).post(`/api/terminals/${coordId}/message`).send({ text: 'Map the repo, please.', source: 'user' }).expect(204);
    await request(app).post(`/api/terminals/${agentId}/message`).send({ text: 'map the repo' }).expect(204);
    await until(() => messagesDb.listForTerminal(db, coordId).some((m) => m.source === 'daemon' && m.text.includes('finished a turn')));

    const log = messagesDb.listForTerminal(db, coordId);
    expect(log.find((m) => m.text === 'Map the repo, please.')?.source).toBe('user');
    const notice = log.find((m) => m.source === 'daemon' && m.text.includes(agentId))!;
    expect(notice.text).toContain('Batch: no other agent is working or queued.');
    expect(notice.text).toContain('Open ledger items: none.');
    expect(messagesDb.listForTerminal(db, agentId)).toEqual([]); // only overseers are logged
  });

  it('a quote resolves end to end against the user\'s real message', async () => {
    const add = await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: coordId, kind: 'decide', text: 'Which store goes first?', options: ['A', 'B'] }).expect(201);
    expect(add.body.id).toBe('N1');
    await sleep(5); // the answer must come strictly after the item
    await request(app).post(`/api/terminals/${coordId}/message`).send({ text: 'N1: A, but only for the first store', source: 'user' }).expect(204);

    const res = await request(app).post(`/api/sessions/${sid}/ledger/N1/resolve`).send({ caller: coordId, status: 'answered', quote: 'a, BUT only   for the first store' }).expect(200);
    expect(res.body.line).toContain('You approved: "Which store goes first?" → "A, but only for the first store"');
    const list = await request(app).post(`/api/sessions/${sid}/ledger/list`).send({ caller: coordId }).expect(200);
    expect(list.body.text).toContain('Decided since the last recap:\n- N1 [Decide] Which store goes first?');
  });

  it('an "ok"-only answer, a canned click, and a non-overseer caller all fail', async () => {
    await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: coordId, kind: 'decide', text: 'Use library A?' }).expect(201);
    await sleep(5);
    await request(app).post(`/api/terminals/${coordId}/message`).send({ text: 'ok', source: 'user' }).expect(204);
    await request(app).post(`/api/terminals/${coordId}/message`).send({ text: '“Use A” — got it.', source: 'user', canned: true }).expect(204);

    const okOnly = await request(app).post(`/api/sessions/${sid}/ledger/N1/resolve`).send({ caller: coordId, status: 'answered', quote: 'ok' }).expect(422);
    expect(okOnly.body.error).toBe("An 'ok' at the start of a message is not an answer. Ask the user.");
    const canned = await request(app).post(`/api/sessions/${sid}/ledger/N1/resolve`).send({ caller: coordId, status: 'answered', quote: 'Use A' }).expect(422);
    expect(canned.body.error).toBe("Quote not found in the user's messages to you after N1 was created. Do not record it. Ask the user.");
    const denied = await request(app).post(`/api/sessions/${sid}/ledger/N1/resolve`).send({ caller: agentId, status: 'withdrawn', reason: 'x' }).expect(403);
    expect(denied.body.error).toBe("Only the project's overseer can change the ledger.");
    expect(messagesDb.listForTerminal(db, coordId).map((m) => m.source)).toEqual(['user', 'canned']);
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd packages/core && npx vitest run tests/routes/overseer-ledger-e2e.test.ts`
Expected: PASS (3 tests). Tasks 1-8 already supply every unit, so this test is green on its first run. If it fails, stop: the failure names a wiring gap. Fix it in the task that owns that unit, not in this test.

- [ ] **Step 3: No production code**

This task adds a test only.

- [ ] **Step 4: Run the full core suite**

Run: `cd packages/core && npx vitest run`
Expected: PASS. Known noise: under full-suite load, the codex-coordinator case in `tests/routes/structured.test.ts` can fail with `read ECONNRESET`. Rerun that file alone (`npx vitest run tests/routes/structured.test.ts`); it must pass alone.

- [ ] **Step 5: Commit**

```bash
git add packages/core/tests/routes/overseer-ledger-e2e.test.ts
git commit -m "$(cat <<'EOF'
test(core): end-to-end check of the overseer message log and ledger quotes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: go items need a named approval

**Files:**
- Modify: `packages/core/src/overseer/ledger-quote.ts` (append)
- Modify: `packages/core/src/overseer/ledger-service.ts` (import line; `resolve`, after the quote check)
- Modify: `packages/core/src/overseer/prompts.ts` (the PROVENANCE line from Task 9)
- Modify: `packages/core/src/overseer/prompts.recap.test.ts` (one more contract line)
- Test: `packages/core/tests/overseer/ledger-go-approval.test.ts`

**Interfaces:**
- Consumes: `findQuote` (Task 3), `LedgerService.resolve` (Task 5).
- Produces:
  - `GO_APPROVAL_ERROR = "A go item needs its ID or the action word in the user's answer. A bare yes is not enough. Ask the user."`
  - `namesGoApproval(quote: string, seq: number): boolean`
  - `resolve` on a `go` item with `status: 'answered'` throws `LedgerError(422, GO_APPROVAL_ERROR)` unless the checked quote (after the ok-word removal) names it. `parked` is not affected. No other task depends on this one; it can be reviewed on its own.

- [ ] **Step 1: Write the failing test**

`packages/core/tests/overseer/ledger-go-approval.test.ts`:

```ts
// Unit 2 rule 7 (decision 5): a go item (merge, deploy, release) becomes answered only when the
// user's words name it — its ID or an action word. A bare "yes" is not enough.
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as ledgerDb from '../../src/db/ledger.js';
import * as messagesDb from '../../src/db/coordinator-messages.js';
import { GO_APPROVAL_ERROR, namesGoApproval } from '../../src/overseer/ledger-quote.js';
import { LedgerService, LedgerError } from '../../src/overseer/ledger-service.js';

describe('namesGoApproval', () => {
  it('"yes" fails; "yes, merge it" and "N12: yes" pass; "emerged" does not count as "merge"', () => {
    expect(namesGoApproval('yes', 12)).toBe(false);
    expect(namesGoApproval('yes, merge it', 12)).toBe(true);
    expect(namesGoApproval('N12: yes', 12)).toBe(true);
    expect(namesGoApproval('emerged', 12)).toBe(false);
  });

  it('every action word counts, in any case, as a whole word only', () => {
    for (const word of ['merge', 'deploy', 'release', 'push', 'restart', 'update', 'MERGE', 'Deploy']) {
      expect(namesGoApproval(`yes, ${word}`, 12), word).toBe(true);
    }
    expect(namesGoApproval('merged it already', 12)).toBe(false);
    expect(namesGoApproval('yes to N123', 12)).toBe(false);
    expect(namesGoApproval('n12 yes', 12)).toBe(true);
  });

  it('has the fixed failure text', () => {
    expect(GO_APPROVAL_ERROR).toBe("A go item needs its ID or the action word in the user's answer. A bare yes is not enough. Ask the user.");
  });
});

describe('ledger_resolve on a go item', () => {
  const T0 = Date.parse('2026-10-05T16:00:00.000Z');
  let db: Database.Database;
  let ledger: LedgerService;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
    terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
    ledger = new LedgerService(db, { clock: () => T0, timeZone: 'UTC' });
    ledger.add('s1', 'coord', { kind: 'go', text: 'Merge PR #12.' });
  });

  const says = (text: string, minute: number) =>
    messagesDb.append(db, { terminalId: 'coord', source: 'user', text, sentAt: new Date(T0 + minute * 60_000).toISOString() });

  function status422(fn: () => unknown): string {
    try { fn(); } catch (e) { expect((e as LedgerError).status).toBe(422); return (e as LedgerError).message; }
    throw new Error('expected a 422');
  }

  it('a bare "yes" does not approve it, and the item stays open', () => {
    says('yes', 1);
    expect(status422(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'yes' }))).toBe(GO_APPROVAL_ERROR);
    expect(ledgerDb.getBySeq(db, 's1', 1)!.status).toBe('open');
  });

  it('"N1: yes" approves it', () => {
    says('N1: yes', 1);
    expect(ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'N1: yes' }).status).toBe('answered');
  });

  it('"ok, merge it" approves it with the quote "merge it" (rule 6 first, then rule 7)', () => {
    says('ok, merge it', 1);
    ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'ok, merge it' });
    expect(ledgerDb.getBySeq(db, 's1', 1)!.quote).toBe('merge it');
  });

  it('parking a go item needs no named approval', () => {
    says('later', 1);
    expect(ledger.resolve('s1', 'coord', { id: 'N1', status: 'parked', quote: 'later' }).status).toBe('parked');
  });

  it('a decide item still accepts a bare "yes"', () => {
    ledger.add('s1', 'coord', { kind: 'decide', text: 'Use library A?' });
    says('yes', 1);
    expect(ledger.resolve('s1', 'coord', { id: 'N2', status: 'answered', quote: 'yes' }).status).toBe('answered');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx vitest run tests/overseer/ledger-go-approval.test.ts`
Expected: FAIL — a `TypeError` that ends in `namesGoApproval is not a function`, the fixed-text test sees `undefined`, and `a bare "yes" does not approve it` fails with `expected a 422` (the item is answered today).

- [ ] **Step 3: Write the implementation**

Append to `packages/core/src/overseer/ledger-quote.ts`:

```ts

// --- Unit 2 rule 7 (decision 5): a go item needs a named approval ----------------------------

export const GO_APPROVAL_ERROR = "A go item needs its ID or the action word in the user's answer. A bare yes is not enough. Ask the user.";

const ACTION_WORD = /(?<![\p{L}\p{N}])(?:merge|deploy|release|push|restart|update)(?![\p{L}\p{N}])/iu;

/**
 * True when a quote (already past the rule-6 ok-word removal) names the go item it approves:
 * its ID (`N12`) or one of the action words, case-insensitive, as a whole word — so "emerged"
 * does not count as "merge", and "N123" does not count as "N12".
 */
export function namesGoApproval(quote: string, seq: number): boolean {
  const id = new RegExp(`(?<![\\p{L}\\p{N}])N${seq}(?![\\p{L}\\p{N}])`, 'iu');
  return id.test(quote) || ACTION_WORD.test(quote);
}
```

In `packages/core/src/overseer/ledger-service.ts`, replace the import line:

```ts
import { findQuote, OK_ONLY_ERROR } from './ledger-quote.js';
```

with:

```ts
import { findQuote, GO_APPROVAL_ERROR, namesGoApproval, OK_ONLY_ERROR } from './ledger-quote.js';
```

and in `resolve`, replace:

```ts
    if (!match.ok) throw new LedgerError(422, match.reason === 'ok_only' ? OK_ONLY_ERROR : quoteNotFoundAfterError(item.seq));
    const updated = ledgerDb.updateStatus(this.db, sessionId, item.seq, {
```

with:

```ts
    if (!match.ok) throw new LedgerError(422, match.reason === 'ok_only' ? OK_ONLY_ERROR : quoteNotFoundAfterError(item.seq));
    // Rule 7: a go item becomes answered only on a named approval. Parking it needs no name.
    if (item.kind === 'go' && status === 'answered' && !namesGoApproval(match.quote, item.seq)) {
      throw new LedgerError(422, GO_APPROVAL_ERROR);
    }
    const updated = ledgerDb.updateStatus(this.db, sessionId, item.seq, {
```

- [ ] **Step 3b: Tell the overseer how to ask for a go approval**

Without this line, the overseer learns the rule only from a failed check. In `packages/core/src/overseer/prompts.recap.test.ts`, add this entry at the end of the `CONTRACT` array:

```ts
  'For a go item, ask the user to answer with its ID or the action word (for example "N12: merge"); a bare "yes" fails the daemon check.',
```

Run: `cd packages/core && npx vitest run src/overseer/prompts.recap.test.ts`
Expected: FAIL on the new line, for both harnesses.

In `packages/core/src/overseer/prompts.ts`, in the PROVENANCE line that Task 9 added, replace:

```ts
  'own words as the owner’s rule.\n' +
```

with:

```ts
  'own words as the owner’s rule. For a go item, ask the user to answer with its ID or the action word ' +
  '(for example "N12: merge"); a bare "yes" fails the daemon check.\n' +
```

That string occurs once in `prompts.ts`. It does not touch any of the six Codex marker strings.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd packages/core && npx vitest run tests/overseer/ledger-go-approval.test.ts tests/overseer/ tests/routes/ledger.test.ts tests/routes/overseer-ledger-e2e.test.ts src/overseer/`
Expected: PASS (8 new tests plus the new contract line; no earlier test answers a `go` item, so nothing else changes).

Run: `cd packages/core && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/overseer/ledger-quote.ts packages/core/src/overseer/ledger-service.ts packages/core/tests/overseer/ledger-go-approval.test.ts packages/core/src/overseer/prompts.ts packages/core/src/overseer/prompts.recap.test.ts
git commit -m "$(cat <<'EOF'
feat(core): a go item needs its ID or the action word to be approved

A bare "yes" no longer approves a merge, deploy or release item.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification (after Task 12)

Not a task: a gate before the branch goes to review.

1. Run `cd packages/core && npx vitest run` and `cd packages/web && npx vitest run`. Both pass (see the Task 11 note on the known `ECONNRESET` flake).
2. Run `cd packages/core && npx tsc --noEmit -p .` and `cd packages/web && npx tsc -b`. Both are clean.
3. Use superpowers:finishing-a-development-branch. Open a PR at most. Do not merge, release or deploy without the user's own approval of that action.
4. Rollout, after a separate deploy approval: each overseer calls `ledger_import` once, and the user confirms or drops the imported items. A running overseer picks up the new persona only when its process restarts.
