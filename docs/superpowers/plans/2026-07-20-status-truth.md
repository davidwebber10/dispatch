# Phase 1 — Status truth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a thread that ends its turn needing the human actually *say so*, instead of being filed as finished.

**Architecture:** Agents declare their end state through a new `report_status` MCP tool; the declaration is stored on the live session (exactly like the existing `lastToolUse`) and consulted by the turn-end `result` handler, which gains a third branch. When nothing was declared, a pure text heuristic on the final assistant message catches trailing questions and marks them as *inferred*. A new `needs-help` manager event carries this to `StatusService.markNeedsInput`, deliberately bypassing the `idle` path so an agent that asked a question never tells its coordinator it "✅ just finished".

**Tech Stack:** TypeScript, ESM, Express + better-sqlite3 (`packages/core`), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-20-thread-board-design.md` (Phase 1 only — the board is Phase 2 and is NOT in this plan).

**Deliberately deferred from the spec's Phase 1.** The spec lists *1c. Reconcile the status
vocabularies* — collapsing the three unaligned status vocabularies (persisted
`terminals.status`, live `ThreadStatus`, Overseer's render-time status) into one. That is
NOT in this plan. It touches every status consumer for no user-visible gain in Phase 1,
and Phase 2 is what actually forces the question — the board needs one vocabulary that
survives a restart, and it should be designed against the board's real needs rather than
guessed at now. Phase 1 adds no new status value: `needs_you` reuses the existing
`needs_input`, and `done`/`blocked` both settle to the existing `idle`. Nothing here makes
the reconciliation harder later.

## Global Constraints

- `packages/core` is ESM: **all relative imports carry a `.js` suffix**, including in tests.
- Core tests: `pnpm -C packages/core test`. Build: `pnpm -C packages/core build`.
- The declaration must **never be applied eagerly**. It is stored on the session and read at turn end. Applying it when the tool fires is a race the agent always loses, because `result` → `idle` lands afterwards and overwrites it.
- `report_status` must reach **every** claude-code/codex thread — plain, agent, and coordinator alike. The gate is `isPeerEligible(type)`, already used for the other peer tools. Do not gate on role.
- A caller identifies itself via the **`DISPATCH_TERMINAL`** env var (`selfTerminalId()` in `agency-mcp.ts`). Never accept a terminal id as a tool argument — an agent could report on another thread's behalf.
- Declared states map to exactly: `done` → complete/idle, `needs_you` → needs-help, `blocked` → working. `blocked` is NOT a new status; a thread waiting on another agent still proceeds without the human.
- Inferred asks must be distinguishable from declared ones in the persisted record, so Phase 2 can render them differently and so the false-positive rate is measurable.
- Commit after every task.

---

## File Structure

- **Create** `packages/core/src/status/question.ts` — pure `looksLikeQuestion(text)` heuristic. Own file so it is unit-testable and tunable without touching the manager.
- **Create** `packages/core/src/status/question.test.ts`
- **Modify** `packages/core/src/structured/manager.ts` — `Session.declared` field, `noteDeclaredStatus()` on the `IStructuredManager` interface and the Claude implementation, third branch in the `result` handler, new `needs-help` event.
- **Modify** `packages/core/src/structured/codex-manager.ts` — implement `noteDeclaredStatus()` for interface parity.
- **Modify** `packages/core/src/sessions/service.ts` — `reportStatus(terminalId, decl)` service method; persist `lastOutcome` onto terminal config.
- **Modify** `packages/core/src/routes/terminals.ts` — `POST /terminals/:terminalId/report-status`.
- **Modify** `packages/core/src/overseer/agency-mcp.ts` — `report_status` in `TOOLS`, a handler, a `callTool` case.
- **Modify** `packages/core/src/overseer/prompts.ts` — teach the tool in `buildPeerPrompt`.
- **Modify** `packages/core/src/server.ts` — wire the `needs-help` event.
- **Modify** `packages/core/tests/overseer/agency-mcp.test.ts` — the hard-coded `TOOLS` count (currently **16**) becomes **17**.

---

## Task 1: The question heuristic

**Files:**
- Create: `packages/core/src/status/question.ts`
- Test: `packages/core/src/status/question.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function looksLikeQuestion(text: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { looksLikeQuestion } from './question.js';

describe('looksLikeQuestion', () => {
  it('catches a trailing question mark', () => {
    expect(looksLikeQuestion('I refactored the rail. Does that look right?')).toBe(true);
  });

  it('catches an ask with no question mark', () => {
    expect(looksLikeQuestion('I can go either way here — let me know which you prefer.')).toBe(true);
    expect(looksLikeQuestion('Before I continue I need the staging credentials.')).toBe(true);
  });

  it('ignores a question that is not the last thing said', () => {
    // The model posed a rhetorical question mid-answer and then finished the work.
    expect(looksLikeQuestion('Why does this fail? Because the guard runs first. Fixed in a04695f.')).toBe(false);
  });

  it('ignores a plain completion report', () => {
    expect(looksLikeQuestion('Merged to main. 6 commits, all tests green.')).toBe(false);
    expect(looksLikeQuestion('Done — shipped v2.6.0.')).toBe(false);
  });

  it('ignores a question inside a code block', () => {
    expect(looksLikeQuestion('Added the guard:\n```\nif (!ok) throw new Error("who?");\n```')).toBe(false);
  });

  it('is safe on empty and whitespace input', () => {
    expect(looksLikeQuestion('')).toBe(false);
    expect(looksLikeQuestion('   \n  ')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C packages/core test -- question`
Expected: FAIL — cannot resolve `./question.js`.

- [ ] **Step 3: Implement**

Create `packages/core/src/status/question.ts`:

```ts
/**
 * Does this turn end by asking the human for something?
 *
 * The backstop for when an agent doesn't call `report_status`. Claude Code's turn-end
 * `result` event carries no indication of intent, so without this a turn ending
 * "…does that look right?" is indistinguishable from one that finished the job.
 *
 * Deliberately checks only the CLOSING sentence, not the whole message: models pose
 * rhetorical questions mid-explanation constantly ("Why does this fail? Because…"),
 * and treating those as asks would flood the needs-help state with false positives.
 * What matters is how the turn was left.
 *
 * Never used when the agent declared its state — declaration always wins.
 */

// Fenced code blocks routinely contain question marks in strings and comments; strip
// them before looking at the prose so `throw new Error("who?")` isn't read as an ask.
const FENCE = /```[\s\S]*?```/g;

// Phrasings that hand the decision back without necessarily using a question mark.
const ASK_PHRASES = [
  /\blet me know\b/i,
  /\bwhich (one )?(would you|do you)\b/i,
  /\bdo you want\b/i,
  /\bwould you (like|prefer)\b/i,
  /\bshould i\b/i,
  /\bshall i\b/i,
  /\bconfirm\b/i,
  /\byour call\b/i,
  /\bup to you\b/i,
  /\bi need (the|your|a)\b/i,
  /\bwaiting (on|for) you\b/i,
];

export function looksLikeQuestion(text: string): boolean {
  const prose = (text ?? '').replace(FENCE, ' ').trim();
  if (!prose) return false;

  // The closing sentence — split on terminators, keep the last non-empty fragment.
  const sentences = prose.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const last = sentences[sentences.length - 1] ?? '';
  if (!last) return false;

  if (last.endsWith('?')) return true;
  return ASK_PHRASES.some((re) => re.test(last));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C packages/core test -- question`
Expected: PASS, all six cases.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/status/question.ts packages/core/src/status/question.test.ts
git commit -m "feat(core): looksLikeQuestion — detect a turn that ends by asking

Backstop for when an agent doesn't declare its end state. Checks only the
closing sentence, since models pose rhetorical questions mid-explanation
constantly and those must not read as asks."
```

---

## Task 2: Session-stored declaration + turn-end branching

**Files:**
- Modify: `packages/core/src/structured/manager.ts`
- Modify: `packages/core/src/structured/codex-manager.ts`
- Test: `packages/core/src/structured/manager.test.ts` (create if absent)

**Interfaces:**
- Consumes: `looksLikeQuestion(text)` from Task 1.
- Produces:
  - `export interface StatusDeclaration { state: 'done' | 'needs_you' | 'blocked'; summary: string; ask?: string; blocker?: string }`
  - `IStructuredManager.noteDeclaredStatus(terminalId: string, decl: StatusDeclaration): void`
  - A new manager event: `'needs-help'` with payload `(terminalId: string, detail: { ask: string; summary: string; inferred: boolean })`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/structured/manager.test.ts`. Drive the manager's line parser directly rather than spawning a real CLI.

```ts
import { describe, it, expect, vi } from 'vitest';
import { looksLikeQuestion } from '../status/question.js';

describe('looksLikeQuestion wiring contract', () => {
  it('is the backstop the manager uses for an undeclared question turn', () => {
    expect(looksLikeQuestion('Rewired the rail. Does that look right?')).toBe(true);
    expect(looksLikeQuestion('Rewired the rail. All tests pass.')).toBe(false);
  });
});
```

Then the real behavioural coverage goes in the existing end-to-end suite, which already
drives a fake CLI. Add to `packages/core/tests/routes/structured.test.ts`, following the
existing `pollEvent` pattern in that file:

```ts
it('a turn ending with a plain-text question marks the thread needs_input, not waiting', async () => {
  // fake-claude emits an assistant message then a result with no report_status call.
  const id = await createStructuredTerminal({ text: 'I rewired the rail. Does that look right to you?' });
  await pollStatus(id, 'needs_input');
  const row = terminalsDb.getById(db, id);
  expect(row?.status).toBe('needs_input');
});

it('a turn ending with a completion report stays waiting', async () => {
  const id = await createStructuredTerminal({ text: 'Merged to main. 6 commits, all green.' });
  await pollStatus(id, 'waiting');
  expect(terminalsDb.getById(db, id)?.status).toBe('waiting');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C packages/core test -- structured`
Expected: FAIL — the question turn settles to `waiting`, because nothing inspects text.

- [ ] **Step 3: Add the declaration type and session field**

In `packages/core/src/structured/manager.ts`, beside the other exported types:

```ts
/** What an agent declared about how its turn ended, via the report_status tool. */
export interface StatusDeclaration {
  state: 'done' | 'needs_you' | 'blocked';
  summary: string;
  ask?: string;
  blocker?: string;
}
```

Add to the `Session` interface (around line 49, next to `lastToolUse`):

```ts
  /**
   * The agent's own declaration for the CURRENT turn, set by report_status and consumed
   * at the `result` boundary. Same lifecycle as lastToolUse: written mid-turn, read once
   * at turn end, then cleared. It must NOT be applied when the tool fires — `result`
   * lands afterwards and would overwrite it.
   */
  declared?: StatusDeclaration;
```

Add to the `IStructuredManager` interface (around line 105, beside `compact`):

```ts
  noteDeclaredStatus(terminalId: string, decl: StatusDeclaration): void;
```

- [ ] **Step 4: Implement `noteDeclaredStatus` on both managers**

In `manager.ts`, beside `compact()`:

```ts
  /**
   * Record what the agent says about this turn. Stored, not applied — the `result`
   * handler reads it at the turn boundary. See Session.declared.
   */
  noteDeclaredStatus(terminalId: string, decl: StatusDeclaration): void {
    const s = this.sessions.get(terminalId);
    if (s) s.declared = decl;
  }
```

In `packages/core/src/structured/codex-manager.ts`, add the identical method (Codex
sessions carry the same per-terminal session map) so the interface is satisfied for both
transports.

- [ ] **Step 5: Add the third branch to the `result` handler**

Replace the `if (event?.type === 'result') { … }` block in `manager.ts` (around line 240):

```ts
      if (event?.type === 'result') {
        const declared = session.declared;
        const wake = session.lastToolUse && WAKE_TOOLS.has(session.lastToolUse.name) ? session.lastToolUse : undefined;
        session.lastToolUse = undefined; // reset for the next turn
        session.declared = undefined;    // ditto — a declaration is per-turn

        // Declaration wins over everything: the agent told us, so don't guess.
        // `blocked` deliberately falls through to 'idle' — a thread waiting on another
        // agent still proceeds without the human, so it isn't a needs-help state.
        if (declared?.state === 'needs_you') {
          this.emit('needs-help', terminalId, { ask: declared.ask ?? declared.summary, summary: declared.summary, inferred: false });
        } else if (declared) {
          this.emit('idle', terminalId);
        } else if (wake) {
          this.emit('scheduled', terminalId, wakeActivity(wake.name, wake.input));
        } else {
          // Nothing declared. Read the closing text ONCE — this walks the event ring,
          // so calling it in both the condition and the body would scan it twice.
          const text = this.lastAssistantText(terminalId);
          if (looksLikeQuestion(text)) {
            // The case that used to be filed as finished. Marked inferred so it renders
            // as a guess and so the false-positive rate stays measurable.
            this.emit('needs-help', terminalId, { ask: text, summary: text, inferred: true });
          } else {
            this.emit('idle', terminalId);
          }
        }

        if (session.pendingSource) this.emit('message-source', terminalId, session.pendingSource);
        session.pendingSource = undefined;
      }
```

Add the import at the top of `manager.ts`:

```ts
import { looksLikeQuestion } from '../status/question.js';
```

- [ ] **Step 6: Add the private `lastAssistantText` helper to the manager**

`SessionService` has its own copy (`service.ts:905`) that reads through `getEvents`. The
manager needs one locally since it decides at the boundary. Add beside `getEvents`:

```ts
  /**
   * The most recent assistant text in this session's event ring — what the turn ended
   * on. Mirrors SessionService.lastAssistantText, which reads the same ring from outside.
   */
  private lastAssistantText(terminalId: string, max = 2000): string {
    const events = this.sessions.get(terminalId)?.events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e: any = events[i];
      if (e?.type === 'assistant' && Array.isArray(e.message?.content)) {
        const text = e.message.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join('').trim();
        if (text) return text.length > max ? text.slice(0, max) : text;
      }
    }
    return '';
  }
```

- [ ] **Step 7: Run tests**

Run: `pnpm -C packages/core test`
Expected: PASS — including the two new structured cases and every pre-existing test.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/structured/manager.ts packages/core/src/structured/codex-manager.ts packages/core/src/structured/manager.test.ts packages/core/tests/routes/structured.test.ts
git commit -m "feat(core): turn-end consults a declared status, falls back to a question heuristic

The result handler previously had two branches — wake-scheduler, or idle —
and never inspected content, so a turn ending in a question was filed as
finished. Adds a session-stored declaration (read at the boundary, never
applied eagerly) plus a needs-help event for declared and inferred asks."
```

---

## Task 3: Service method + REST route

**Files:**
- Modify: `packages/core/src/sessions/service.ts`
- Modify: `packages/core/src/routes/terminals.ts`
- Test: `packages/core/src/routes/terminals.test.ts`

**Interfaces:**
- Consumes: `StatusDeclaration`, `IStructuredManager.noteDeclaredStatus` from Task 2.
- Produces: `SessionService.reportStatus(terminalId: string, decl: StatusDeclaration): boolean` and `POST /api/terminals/:terminalId/report-status`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/routes/terminals.test.ts` (the file already uses an express
+ supertest app factory with a stubbed service — follow it):

```ts
describe('POST /api/terminals/:id/report-status', () => {
  it('forwards a valid declaration to the service', async () => {
    const reportStatus = vi.fn().mockReturnValue(true);
    const res = await request(app({ reportStatus }))
      .post('/api/terminals/t1/report-status')
      .send({ state: 'needs_you', summary: 'blocked on a decision', ask: 'Which provider?' });
    expect(res.status).toBe(204);
    expect(reportStatus).toHaveBeenCalledWith('t1', { state: 'needs_you', summary: 'blocked on a decision', ask: 'Which provider?' });
  });

  it('rejects an unknown state', async () => {
    const res = await request(app({ reportStatus: vi.fn() }))
      .post('/api/terminals/t1/report-status')
      .send({ state: 'vibes', summary: 'x' });
    expect(res.status).toBe(400);
  });

  it('answers 409 when no live structured session backs the thread', async () => {
    const res = await request(app({ reportStatus: vi.fn().mockReturnValue(false) }))
      .post('/api/terminals/t1/report-status')
      .send({ state: 'done', summary: 'shipped' });
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C packages/core test -- terminals`
Expected: FAIL with 404 — the route does not exist.

- [ ] **Step 3: Add the service method**

In `packages/core/src/sessions/service.ts`, beside `compact()`:

```ts
  /**
   * Record an agent's own account of how its turn ended. Stored on the live session and
   * consulted at the `result` boundary — see StructuredSessionManager.noteDeclaredStatus.
   * Returns false when no live structured session backs the thread.
   */
  reportStatus(terminalId: string, decl: StatusDeclaration): boolean {
    const manager = this.structuredManagerForTerminal(terminalId);
    if (!manager || !manager.isAlive(terminalId)) return false;
    manager.noteDeclaredStatus(terminalId, decl);
    return true;
  }
```

Add `StatusDeclaration` to the existing `../structured/manager.js` import.

- [ ] **Step 4: Add the route**

In `packages/core/src/routes/terminals.ts`, directly after the `compact` handler:

```ts
  // POST /api/terminals/:terminalId/report-status — an agent's own account of how its
  // turn ended. Stored on the live session, consulted at the turn boundary; never
  // applied eagerly, since the `result` event lands afterwards and would overwrite it.
  router.post('/terminals/:terminalId/report-status', (req, res) => {
    const { state, summary, ask, blocker } = req.body ?? {};
    if (state !== 'done' && state !== 'needs_you' && state !== 'blocked') {
      return res.status(400).json({ error: "state must be 'done', 'needs_you' or 'blocked'" });
    }
    if (typeof summary !== 'string' || !summary.trim()) {
      return res.status(400).json({ error: 'summary is required' });
    }
    try {
      const decl: any = { state, summary };
      if (typeof ask === 'string' && ask.trim()) decl.ask = ask;
      if (typeof blocker === 'string' && blocker.trim()) decl.blocker = blocker;
      const ok = sessionService.reportStatus(req.params.terminalId, decl);
      if (!ok) return res.status(409).json({ error: 'No live structured session to report on' });
      res.status(204).end();
    } catch (e: any) { res.status(400).json({ error: e?.message ?? String(e) }); }
  });
```

- [ ] **Step 5: Run tests**

Run: `pnpm -C packages/core test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/sessions/service.ts packages/core/src/routes/terminals.ts packages/core/src/routes/terminals.test.ts
git commit -m "feat(core): POST /api/terminals/:id/report-status"
```

---

## Task 4: The `report_status` MCP tool + prompt instruction

**Files:**
- Modify: `packages/core/src/overseer/agency-mcp.ts`
- Modify: `packages/core/src/overseer/prompts.ts`
- Test: `packages/core/tests/overseer/agency-mcp.test.ts`
- Test: `packages/core/tests/overseer/prompts.test.ts`

**Interfaces:**
- Consumes: `POST /api/terminals/:id/report-status` from Task 3.
- Produces: the `report_status` tool, reaching every peer-eligible thread.

- [ ] **Step 1: Write the failing test**

In `packages/core/tests/overseer/agency-mcp.test.ts`, bump the hard-coded count on line 39
from `16` to `17`, add `'report_status'` to the expected tool-name set, and append:

```ts
it('report_status posts the declaration for the CALLING thread', async () => {
  process.env.DISPATCH_TERMINAL = 'self-1';
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 204, text: async () => '' });
  global.fetch = fetchMock as any;

  const out = await callTool('report_status', { state: 'needs_you', summary: 'need a decision', ask: 'Which provider?' });

  expect(out.isError).toBeFalsy();
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toContain('/api/terminals/self-1/report-status');
  expect(init.method).toBe('POST');
  expect(JSON.parse(init.body)).toEqual({ state: 'needs_you', summary: 'need a decision', ask: 'Which provider?' });
});

it('report_status refuses to report on another thread', async () => {
  process.env.DISPATCH_TERMINAL = 'self-1';
  const out = await callTool('report_status', { state: 'done', summary: 'x', id: 'other-thread' } as any);
  // `id` is not in the schema and must be ignored — the URL is always the caller's own.
  expect(String(out.content[0].text)).not.toContain('other-thread');
});
```

In `packages/core/tests/overseer/prompts.test.ts`:

```ts
it('teaches report_status to every peer-eligible thread', () => {
  const prompt = buildPeerPrompt({ label: 'x', terminalId: 't1', sessionId: 's1', peers: [] } as any);
  expect(prompt).toContain('report_status');
  expect(prompt).toContain('end of every turn');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C packages/core test -- agency-mcp`
Expected: FAIL — `TOOLS` has 16 entries and `Unknown tool: report_status`.

- [ ] **Step 3: Add the tool schema**

In `packages/core/src/overseer/agency-mcp.ts`, append to the `TOOLS` array:

```ts
  {
    name: 'report_status',
    description:
      'Declare how YOUR OWN turn is ending. Call this as the last thing you do, every turn. ' +
      'It is how the human sees whether you finished, need them, or are blocked — without it ' +
      'a turn that ends by asking a question looks identical to one that finished the work.',
    inputSchema: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          enum: ['done', 'needs_you', 'blocked'],
          description: "'done' = the work is finished. 'needs_you' = you cannot proceed until the human answers. 'blocked' = waiting on another agent or a timer, no human needed.",
        },
        summary: { type: 'string', description: 'One line: what happened this turn.' },
        ask: { type: 'string', description: 'The actual question, when state is needs_you.' },
        blocker: { type: 'string', description: 'What you are waiting on, when state is blocked.' },
      },
      required: ['state', 'summary'],
    },
  },
```

- [ ] **Step 4: Add the handler and the switch case**

Beside the other handlers in `agency-mcp.ts`:

```ts
async function reportStatus(args: { state: string; summary: string; ask?: string; blocker?: string }): Promise<{ ok: true }> {
  if (!args?.state) throw new Error('state is required');
  if (!args?.summary) throw new Error('summary is required');
  // Always the caller's OWN terminal — never a routable argument, or an agent could
  // report on a peer's behalf.
  const self = requireSelf();
  const body: Record<string, string> = { state: args.state, summary: args.summary };
  if (args.ask) body.ask = args.ask;
  if (args.blocker) body.blocker = args.blocker;
  await httpJson('POST', `${apiBase()}/api/terminals/${self}/report-status`, body);
  return { ok: true };
}
```

And in the `callTool` switch:

```ts
      case 'report_status': result = await reportStatus(args ?? {}); break;
```

- [ ] **Step 5: Teach it in the peer prompt**

In `packages/core/src/overseer/prompts.ts`, inside `buildPeerPrompt`, append to the peer-tools
list block:

```ts
'- report_status({ state, summary, ask?, blocker? }) — declare how your turn is ending. ' +
'CALL THIS AT THE END OF EVERY TURN, as your last action. `done` when the work is finished, ' +
'`needs_you` when you cannot proceed without the human (put the question in `ask`), `blocked` ' +
'when you are waiting on another agent or a timer. Without it, a turn you ended by asking a ' +
'question is indistinguishable from one where you finished — and the human will never see it.\n'
```

- [ ] **Step 6: Run tests**

Run: `pnpm -C packages/core test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/overseer/agency-mcp.ts packages/core/src/overseer/prompts.ts packages/core/tests/overseer/agency-mcp.test.ts packages/core/tests/overseer/prompts.test.ts
git commit -m "feat(core): report_status MCP tool, taught to every peer-eligible thread

Identity comes from DISPATCH_TERMINAL, never a tool argument, so a thread
can only ever report on itself."
```

---

## Task 5: Wire `needs-help`, and persist the outcome

**Files:**
- Modify: `packages/core/src/server.ts`
- Modify: `packages/core/src/sessions/service.ts`
- Test: `packages/core/tests/routes/structured.test.ts`

**Interfaces:**
- Consumes: the `needs-help` event from Task 2.
- Produces: `SessionService.noteTurnOutcome(terminalId, detail)` persisting `config.lastOutcome`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/tests/routes/structured.test.ts`:

```ts
it('an agent that ends by asking does NOT tell its coordinator it finished', async () => {
  const { agentId, coordinatorId } = await spawnAgentUnderCoordinator({ text: 'Ready to deploy. Shall I proceed?' });
  await pollStatus(agentId, 'needs_input');
  const coordinatorEvents = await readEvents(coordinatorId);
  expect(JSON.stringify(coordinatorEvents)).not.toContain('just finished a turn');
});

it('persists the turn outcome onto the terminal config', async () => {
  const id = await createStructuredTerminal({ text: 'Merged to main. 6 commits, all green.' });
  await pollStatus(id, 'waiting');
  const cfg = JSON.parse(terminalsDb.getById(db, id)?.config || '{}');
  expect(cfg.lastOutcome?.summary).toContain('Merged to main');
  expect(cfg.lastOutcome?.needsHelp).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C packages/core test -- structured`
Expected: FAIL — no `needs-help` listener exists, so the thread settles to `waiting` and the coordinator gets the completion notice.

- [ ] **Step 3: Add the outcome persistence**

In `packages/core/src/sessions/service.ts`:

```ts
  /**
   * Persist how the last turn ended onto the terminal's config, so a card can show a real
   * outcome line ("✓ merged, 6 commits") instead of a thread name, and so the
   * declared-vs-inferred split is measurable off the DB.
   */
  noteTurnOutcome(terminalId: string, detail: { summary: string; needsHelp: boolean; inferred: boolean }): void {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return;
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }
    cfg.lastOutcome = {
      summary: detail.summary.slice(0, 400),
      needsHelp: detail.needsHelp,
      inferred: detail.inferred,
      at: new Date().toISOString(),
    };
    try { terminalsDb.updateConfig(this.db, terminalId, cfg); } catch { /* best effort */ }
  }
```

- [ ] **Step 4: Wire the event in `server.ts`**

Beside the existing `structuredManager.on('idle', …)` block:

```ts
  // A turn that ended needing the human. Deliberately NOT routed through 'idle':
  // markIdle settles the thread to `waiting` and noteAgentCompletion tells the
  // coordinator the agent "✅ just finished" — both wrong for a thread that stopped
  // to ask a question.
  structuredManager.on('needs-help', (terminalId: string, detail: { ask: string; summary: string; inferred: boolean }) => {
    statusService.markNeedsInput(terminalId, detail.inferred ? 'Asked a question' : detail.ask.slice(0, 120));
    sessionService.noteTurnOutcome(terminalId, { summary: detail.summary, needsHelp: true, inferred: detail.inferred });
  });
```

And extend the existing `idle` listener to record the outcome too:

```ts
  structuredManager.on('idle', (terminalId: string) => {
    statusService.markIdle(terminalId);
    sessionService.noteTurnOutcome(terminalId, { summary: sessionService.lastAssistantTextPublic(terminalId), needsHelp: false, inferred: false });
    sessionService.noteAgentCompletion(terminalId);
  });
```

Add a public accessor in `service.ts` beside the private `lastAssistantText`:

```ts
  /** Public wrapper — server.ts needs the same text for the outcome line. */
  lastAssistantTextPublic(terminalId: string, max = 400): string {
    return this.lastAssistantText(terminalId, max);
  }
```

Repeat both listener registrations for the Codex manager if `server.ts` wires the two
managers separately — check how the existing `'idle'` listener is registered and mirror it
exactly.

- [ ] **Step 5: Run the full suite**

Run: `pnpm -C packages/core test && pnpm -C packages/core build`
Expected: PASS on both.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/server.ts packages/core/src/sessions/service.ts packages/core/tests/routes/structured.test.ts
git commit -m "feat(core): route needs-help to markNeedsInput, persist turn outcome

An agent that ended by asking no longer tells its coordinator it finished,
and every turn now records a one-line outcome plus whether the needs-help
call was declared or inferred."
```

---

## Task 6: Observability — declared vs inferred

**Files:**
- Modify: `packages/core/src/server.ts`
- Test: `packages/core/tests/routes/structured.test.ts`

**Interfaces:**
- Consumes: `config.lastOutcome` from Task 5.
- Produces: `GET /api/state/status-quality` returning `{ declared: number; inferred: number; total: number }`.

The spec makes this a precondition for Phase 2: *"Phase 1 should be observable — log
declared-vs-inferred rates — before Phase 2 depends on it."* Without it there is no way to
know whether the heuristic is noisy or whether agents actually call the tool.

- [ ] **Step 1: Write the failing test**

Follow `packages/core/tests/routes/state.test.ts`'s existing pattern — it builds the app
per test via an `app()` factory over an in-memory `better-sqlite3` DB:

```ts
it('reports the declared-vs-inferred split across threads', async () => {
  const res = await request(app()).get('/api/state/status-quality');
  expect(res.status).toBe(200);
  expect(res.body).toEqual(expect.objectContaining({ declared: expect.any(Number), inferred: expect.any(Number), total: expect.any(Number) }));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C packages/core test -- state`
Expected: FAIL with 404.

- [ ] **Step 3: Implement**

In `packages/core/src/routes/state.ts` (the router that already serves `/api/state/update`):

```ts
  // GET /api/state/status-quality — how often agents declare their end state versus how
  // often the heuristic had to guess. Phase 2 (the board) leans on needs-help being
  // trustworthy; this is how we find out whether it is, before building on it.
  router.get('/status-quality', (_req, res) => {
    const rows = db.prepare("SELECT config FROM terminals WHERE config LIKE '%lastOutcome%'").all() as { config: string }[];
    let declared = 0, inferred = 0;
    for (const r of rows) {
      try {
        const outcome = JSON.parse(r.config || '{}').lastOutcome;
        if (!outcome) continue;
        if (outcome.inferred) inferred++; else declared++;
      } catch { /* skip malformed */ }
    }
    res.json({ declared, inferred, total: declared + inferred });
  });
```

- [ ] **Step 4: Run tests**

Run: `pnpm -C packages/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routes/state.ts packages/core/tests/routes/state.test.ts
git commit -m "feat(core): GET /api/state/status-quality — declared vs inferred rates

The spec makes measuring this a precondition for Phase 2: the board's
central column is only worth building if needs-help is trustworthy."
```

---

## Verification before finishing

- [ ] `pnpm -C packages/core test` — green
- [ ] `pnpm -C packages/core build` — clean
- [ ] `pnpm -C packages/web test` — green (unchanged, but prove nothing regressed)
- [ ] Manual, against a live daemon: send a thread a prompt that makes it end with a question; confirm it settles to `needs_input` and appears in the existing "Needs you" alert rather than under Done in the Work rail.
- [ ] Manual: confirm `GET /api/state/status-quality` returns a sane split after a few turns.

## What this ships without any board

- The Work rail stops filing question-ending turns under Done.
- The existing "Needs you" header alert catches prose questions, not just `AskUserQuestion` calls and permission prompts.
- Every thread records a one-line outcome, which Phase 2's cards will render.
- Real numbers on declaration compliance and heuristic noise, before Phase 2 is designed on top of them.
