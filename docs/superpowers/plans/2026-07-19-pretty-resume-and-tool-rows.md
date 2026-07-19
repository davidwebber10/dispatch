# Pretty resume-from-summary + lighter tool rows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Pretty (structured) threads the resume-from-summary choice the CLI shows, and reduce tool calls from heavy bordered boxes to light scannable rows that group consecutive same-tool runs.

**Architecture:** Part A adds a read-only daemon endpoint that classifies a thread's transcript (age + context size) against the CLI's own thresholds, and a dismissible ChatView card that calls the existing `/compact` endpoint. Part B restyles the shared `ToolCall` row and adds a grouping pass to `ChatView.renderTimeline`.

**Tech Stack:** TypeScript, Express + better-sqlite3 (`packages/core`), React 18 + Zustand + Vitest/@testing-library (`packages/web`).

## Global Constraints

- `packages/core` is ESM: **all relative imports carry a `.js` suffix**, including in tests.
- `packages/web` uses **inline `style={{}}` plus CSS custom properties from `theme.css`**. There is **no Tailwind** — do not introduce class-based utility styling.
- Colors come from tokens (`var(--color-*)`). Do not hardcode hex values except where the file already does.
- Threshold defaults are **70 minutes** and **100000 tokens**, overridable by `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES` and `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD` — the same env vars Claude Code reads, so both surfaces agree.
- Context size formula is `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, matching `useStructuredChat.ts:495`.
- Core tests: `pnpm -C packages/core test`. Web tests: `pnpm -C packages/web test`.
- Commit after every task.

---

## File Structure

**Part A**
- Modify `packages/core/src/sessions/cc-sessions.ts` — add `resumeAdvice()`; extend the private `readLastTurn()` to also capture the last assistant `usage`.
- Modify `packages/core/src/sessions/service.ts` — add `getResumeAdvice(terminalId)`, resolving workDir + external_id.
- Modify `packages/core/src/routes/terminals.ts` — add `GET /terminals/:terminalId/resume-advice`.
- Modify `packages/web/src/api/client.ts` — add `getResumeAdvice()` and export the `ResumeAdvice` type.
- Modify `packages/web/src/stores/settings.ts` — add persisted `resumeAdviceDismissed` + setter.
- Create `packages/web/src/components/tabs/chat/ResumeAdviceCard.tsx` — presentational card.
- Create `packages/web/src/components/tabs/chat/ResumeAdviceCard.test.tsx`.
- Modify `packages/web/src/components/tabs/chat/ChatView.tsx` — fetch advice on mount, render the card above the composer.

**Part B**
- Modify `packages/web/src/components/tabs/ToolCall.tsx` — lighter collapsed row (shared by ChatView and ConversationView).
- Modify `packages/web/src/components/tabs/chat/ChatView.tsx` — grouping pass in `renderTimeline` + a `ToolGroup` component.
- Modify `packages/web/src/components/tabs/chat/ChatView.test.tsx` — grouping tests.

---

## Task 1: `resumeAdvice()` transcript classifier

**Files:**
- Modify: `packages/core/src/sessions/cc-sessions.ts`
- Test: `packages/core/src/sessions/cc-sessions.test.ts`

**Interfaces:**
- Consumes: the existing private `readLastTurn(workDir, sessionId)` in the same file.
- Produces: `export interface ResumeAdvice { ageMinutes: number; contextTokens: number; shouldPrompt: boolean }` and `export function resumeAdvice(workDir: string, sessionId: string, now?: number): ResumeAdvice | null`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/sessions/cc-sessions.test.ts`. Follow the existing suite's temp-dir + fake-`HOME` pattern; if it does not already have one, this creates it.

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resumeAdvice } from './cc-sessions.js';

describe('resumeAdvice', () => {
  let home: string;
  let origHome: string | undefined;
  const workDir = '/tmp/proj';

  // Claude Code encodes the workdir by replacing every "/" with "-".
  function writeTranscript(sessionId: string, lines: unknown[]) {
    const dir = path.join(home, '.claude', 'projects', workDir.replace(/\//g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
  }

  function assistant(timestamp: string, usage: Record<string, number>) {
    return { type: 'assistant', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage } };
  }

  const BIG = { input_tokens: 20_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 4_000 };
  const SMALL = { input_tokens: 500, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0 };
  const NOW = Date.parse('2026-07-19T12:00:00.000Z');
  const THREE_HOURS_AGO = '2026-07-19T09:00:00.000Z';
  const TEN_MINUTES_AGO = '2026-07-19T11:50:00.000Z';

  beforeEach(() => {
    origHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-advice-'));
    process.env.HOME = home;
    delete process.env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES;
    delete process.env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('prompts when the session is both old and large', () => {
    writeTranscript('s1', [assistant(THREE_HOURS_AGO, BIG)]);
    const advice = resumeAdvice(workDir, 's1', NOW);
    expect(advice).not.toBeNull();
    expect(advice!.shouldPrompt).toBe(true);
    expect(Math.round(advice!.ageMinutes)).toBe(180);
    expect(advice!.contextTokens).toBe(124_000);
  });

  it('does not prompt when the session is large but recent', () => {
    writeTranscript('s2', [assistant(TEN_MINUTES_AGO, BIG)]);
    expect(resumeAdvice(workDir, 's2', NOW)!.shouldPrompt).toBe(false);
  });

  it('does not prompt when the session is old but small', () => {
    writeTranscript('s3', [assistant(THREE_HOURS_AGO, SMALL)]);
    expect(resumeAdvice(workDir, 's3', NOW)!.shouldPrompt).toBe(false);
  });

  it('honors the CLI threshold env vars', () => {
    writeTranscript('s4', [assistant(TEN_MINUTES_AGO, SMALL)]);
    process.env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES = '5';
    process.env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD = '1000';
    expect(resumeAdvice(workDir, 's4', NOW)!.shouldPrompt).toBe(true);
  });

  it('uses the LAST assistant usage, not a sum across turns', () => {
    writeTranscript('s5', [assistant(THREE_HOURS_AGO, BIG), assistant(THREE_HOURS_AGO, SMALL)]);
    expect(resumeAdvice(workDir, 's5', NOW)!.contextTokens).toBe(1_500);
  });

  it('returns null when the transcript is missing', () => {
    expect(resumeAdvice(workDir, 'nope', NOW)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C packages/core test -- cc-sessions`
Expected: FAIL — `resumeAdvice` is not exported from `./cc-sessions.js`.

- [ ] **Step 3: Capture the last assistant usage in `readLastTurn`**

In `packages/core/src/sessions/cc-sessions.ts`, widen the private helper's return type and track usage. Change the signature line:

```ts
function readLastTurn(workDir: string, sessionId: string): { mtimeMs: number; last: any; lastUsage: any } | null {
```

Inside, declare the accumulator next to `let last: any = null;`:

```ts
    let last: any = null;
    let lastUsage: any = null;
```

In the same loop, after the existing `last = o;` assignment, add:

```ts
      if (o.type === 'assistant' && o.message?.usage) lastUsage = o.message.usage;
```

And widen the return:

```ts
    return { mtimeMs: stat.mtimeMs, last, lastUsage };
```

Both existing callers (`transcriptTailStatus`, `transcriptTailScheduled`) destructure only what they use, so they are unaffected.

- [ ] **Step 4: Add `resumeAdvice`**

Append to `packages/core/src/sessions/cc-sessions.ts`:

```ts
export interface ResumeAdvice {
  /** Minutes since the transcript's last user/assistant turn. */
  ageMinutes: number;
  /** Context size as of the last assistant turn (input + cache_read + cache_creation). */
  contextTokens: number;
  /** The session is old AND large enough that resuming it whole is worth warning about. */
  shouldPrompt: boolean;
}

// Claude Code's own defaults for its interactive resume dialog, read from the SAME env
// vars so a user who has tuned them gets one consistent answer in Pretty and the CLI.
const RESUME_AGE_MINUTES = 70;
const RESUME_TOKEN_THRESHOLD = 100_000;

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Should we offer to summarize before resuming this session?
 *
 * Claude Code asks the same question interactively ("This session is 3d 4h old and 134k
 * tokens…"), but that dialog is an Ink component the interactive shell renders — a Pretty
 * thread spawns with `-p` and never sees it, so it would silently resume full context and
 * burn the user's limits. This reproduces the CLI's gate off the transcript on disk.
 *
 * Context size is the LAST assistant turn's usage, not a sum across turns: cumulative
 * usage counts every cache read again on every turn and would wildly overstate what
 * actually sits in the window. Same formula the live ContextIndicator uses.
 *
 * Returns null when the transcript is missing/unreadable (e.g. a thread that never
 * captured an external_id) — the caller treats that as "nothing to advise". Never throws.
 */
export function resumeAdvice(workDir: string, sessionId: string, now = Date.now()): ResumeAdvice | null {
  const r = readLastTurn(workDir, sessionId);
  if (!r || !r.last) return null;
  // Prefer the message's own timestamp; fall back to file mtime when it's absent/unparseable.
  const stamped = Date.parse(r.last.timestamp ?? '');
  const lastActivity = Number.isFinite(stamped) ? stamped : r.mtimeMs;
  const ageMinutes = Math.max(0, (now - lastActivity) / 60000);
  const u = r.lastUsage;
  const contextTokens = u
    ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    : 0;
  const shouldPrompt =
    ageMinutes >= envNumber('CLAUDE_CODE_RESUME_THRESHOLD_MINUTES', RESUME_AGE_MINUTES) &&
    contextTokens >= envNumber('CLAUDE_CODE_RESUME_TOKEN_THRESHOLD', RESUME_TOKEN_THRESHOLD);
  return { ageMinutes, contextTokens, shouldPrompt };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm -C packages/core test -- cc-sessions`
Expected: PASS, all six new cases plus every pre-existing case in the file.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/sessions/cc-sessions.ts packages/core/src/sessions/cc-sessions.test.ts
git commit -m "feat(core): resumeAdvice() — classify a transcript's age and context size

Mirrors Claude Code's interactive resume gate (70min / 100k tokens, same
env overrides) so Pretty threads can offer the summary choice the -p
transport never renders."
```

---

## Task 2: Service method + REST route

**Files:**
- Modify: `packages/core/src/sessions/service.ts`
- Modify: `packages/core/src/routes/terminals.ts`
- Test: `packages/core/src/routes/terminals.test.ts` (create — follows the express + supertest app-factory pattern in `packages/core/src/routes/state.test.ts`)

**Interfaces:**
- Consumes: `resumeAdvice(workDir, sessionId, now?)` and `ResumeAdvice` from Task 1.
- Produces: `SessionService.getResumeAdvice(terminalId: string): ResumeAdvice | null` and `GET /api/terminals/:terminalId/resume-advice`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/routes/terminals.test.ts`. The router only needs the one method
for these cases, so stub the service rather than standing up a real one — this test is
about the route contract, not about `getResumeAdvice`'s logic (covered in Task 1).

```ts
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTerminalsRouter } from './terminals.js';
import type { SessionService } from '../sessions/service.js';

function app(getResumeAdvice: () => unknown) {
  const a = express();
  a.use(express.json());
  a.use('/api', createTerminalsRouter({ getResumeAdvice } as unknown as SessionService));
  return a;
}

describe('GET /api/terminals/:id/resume-advice', () => {
  it('returns the service payload', async () => {
    const advice = { shouldPrompt: true, ageMinutes: 180, contextTokens: 124_000 };
    const res = await request(app(() => advice)).get('/api/terminals/t1/resume-advice');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(advice);
  });

  it('answers a benign "no" when there is nothing to advise on', async () => {
    const res = await request(app(() => null)).get('/api/terminals/t1/resume-advice');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ shouldPrompt: false, ageMinutes: 0, contextTokens: 0 });
  });

  it('surfaces a service throw as 400', async () => {
    const res = await request(app(() => { throw new Error('boom'); })).get('/api/terminals/t1/resume-advice');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('boom');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C packages/core test -- terminals`
Expected: FAIL with 404 — the route does not exist.

- [ ] **Step 3: Add the service method**

In `packages/core/src/sessions/service.ts`, extend the existing `cc-sessions.js` import (line 23) to include the new symbols — alias the function so it does not collide with the method name:

```ts
import { readSessionBackfill, readTerminalTokenUsage, transcriptTailStatus, findNewestUnresolvedUserUuid, applyDurableSources, resumeAdvice as readResumeAdvice, type ResumeAdvice } from './cc-sessions.js';
```

Add the method to the class, alongside the other terminal-scoped readers:

```ts
  /**
   * Should the Pretty view offer to summarize before resuming this thread?
   * Claude-only and transcript-backed: a thread with no external_id has no
   * conversation to resume, and Codex resumes out-of-band over JSON-RPC.
   */
  getResumeAdvice(terminalId: string): ResumeAdvice | null {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal?.external_id || terminal.type !== 'claude-code') return null;
    const session = sessionsDb.getById(this.db, terminal.session_id);
    const workDir = terminal.working_dir || session?.working_dir;
    if (!workDir) return null;
    return readResumeAdvice(workDir, terminal.external_id);
  }
```

- [ ] **Step 4: Add the route**

In `packages/core/src/routes/terminals.ts`, directly after the `POST /terminals/:terminalId/compact` handler (which ends at line 181):

```ts
  // GET /api/terminals/:terminalId/resume-advice — should the Pretty view offer to
  // summarize before resuming? Read-only; a thread with nothing to advise on (no
  // external_id, no transcript, not claude) answers a benign "no".
  router.get('/terminals/:terminalId/resume-advice', (req, res) => {
    try {
      const advice = sessionService.getResumeAdvice(req.params.terminalId);
      res.json(advice ?? { shouldPrompt: false, ageMinutes: 0, contextTokens: 0 });
    } catch (e: any) { res.status(400).json({ error: e?.message ?? String(e) }); }
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm -C packages/core test`
Expected: PASS, whole core suite green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/sessions/service.ts packages/core/src/routes/terminals.ts packages/core/src/routes/terminals.test.ts
git commit -m "feat(core): GET /api/terminals/:id/resume-advice"
```

---

## Task 3: API client + persisted dismissal setting

**Files:**
- Modify: `packages/web/src/api/client.ts`
- Modify: `packages/web/src/stores/settings.ts`

**Interfaces:**
- Consumes: `GET /api/terminals/:id/resume-advice` from Task 2.
- Produces: `api.getResumeAdvice(terminalId): Promise<ResumeAdvice>`, the exported `ResumeAdvice` type, and `useSettings().resumeAdviceDismissed` / `.setResumeAdviceDismissed(b)`.

- [ ] **Step 1: Add the client method**

In `packages/web/src/api/client.ts`, export the type near the other shared response types:

```ts
export interface ResumeAdvice {
  ageMinutes: number;
  contextTokens: number;
  shouldPrompt: boolean;
}
```

And add the method immediately after `compactTerminal` (line 78):

```ts
  // Should the Pretty view offer to summarize before resuming this thread?
  getResumeAdvice: (terminalId: string) => req<ResumeAdvice>(`/api/terminals/${terminalId}/resume-advice`),
```

- [ ] **Step 2: Add the persisted setting**

In `packages/web/src/stores/settings.ts`, add to the `SettingsState` interface next to `multiPane` (line 29):

```ts
  resumeAdviceDismissed: boolean;
```

and next to `setMultiPane` (line 41):

```ts
  setResumeAdviceDismissed: (b: boolean) => void;
```

In the store body, next to the `multiPane` initializer (line 79):

```ts
  resumeAdviceDismissed: load('dispatch:resumeAdviceDismissed', false),
```

and next to `setMultiPane` (line 89):

```ts
  setResumeAdviceDismissed: (b) => { save('dispatch:resumeAdviceDismissed', b); set({ resumeAdviceDismissed: b }); },
```

- [ ] **Step 3: Typecheck**

Run: `pnpm -C packages/web build`
Expected: PASS — `tsc -b && vite build` clean.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/api/client.ts packages/web/src/stores/settings.ts
git commit -m "feat(web): resume-advice client method + persisted dismissal setting"
```

---

## Task 4: `ResumeAdviceCard` component

**Files:**
- Create: `packages/web/src/components/tabs/chat/ResumeAdviceCard.tsx`
- Test: `packages/web/src/components/tabs/chat/ResumeAdviceCard.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks; purely presentational, all state is props.
- Produces: `<ResumeAdviceCard ageMinutes onSummarize onFull onNever contextTokens />`, plus `export function formatAge(minutes: number): string`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResumeAdviceCard, formatAge } from './ResumeAdviceCard';

describe('formatAge', () => {
  it('renders minutes under an hour', () => { expect(formatAge(45)).toBe('45m'); });
  it('renders whole hours without minutes', () => { expect(formatAge(120)).toBe('2h'); });
  it('renders hours and minutes', () => { expect(formatAge(150)).toBe('2h 30m'); });
  it('renders days and hours', () => { expect(formatAge(4560)).toBe('3d 4h'); });
  it('renders whole days without hours', () => { expect(formatAge(4320)).toBe('3d'); });
});

describe('ResumeAdviceCard', () => {
  const props = { ageMinutes: 4560, contextTokens: 134_000, onSummarize: vi.fn(), onFull: vi.fn(), onNever: vi.fn() };

  it('states the session age and size', () => {
    render(<ResumeAdviceCard {...props} />);
    expect(screen.getByText(/3d 4h old and 134,000 tokens/)).toBeTruthy();
  });

  it('fires the matching callback for each action', () => {
    const onSummarize = vi.fn(), onFull = vi.fn(), onNever = vi.fn();
    render(<ResumeAdviceCard {...props} onSummarize={onSummarize} onFull={onFull} onNever={onNever} />);
    fireEvent.click(screen.getByRole('button', { name: /resume from summary/i }));
    fireEvent.click(screen.getByRole('button', { name: /resume full session/i }));
    fireEvent.click(screen.getByRole('button', { name: /don't ask again/i }));
    expect(onSummarize).toHaveBeenCalledOnce();
    expect(onFull).toHaveBeenCalledOnce();
    expect(onNever).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C packages/web test -- ResumeAdviceCard`
Expected: FAIL — cannot resolve `./ResumeAdviceCard`.

- [ ] **Step 3: Write the component**

```tsx
import { Sparkle } from '@phosphor-icons/react';

/** "3d 4h" / "2h 30m" / "45m" — mirrors the CLI's own age wording in this dialog. */
export function formatAge(minutes: number): string {
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rem = Math.floor(minutes % 60);
    return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  }
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  return rem === 0 ? `${days}d` : `${days}d ${rem}h`;
}

interface Props {
  ageMinutes: number;
  contextTokens: number;
  onSummarize: () => void;
  onFull: () => void;
  onNever: () => void;
}

/**
 * The choice Claude Code shows interactively when resuming an old, large session.
 * Pretty threads run with `-p`, which never renders that Ink dialog, so without this
 * the full session resumes silently and eats the user's limits. Deliberately a
 * dismissible card rather than a modal: nothing here needs to block the composer.
 */
export function ResumeAdviceCard({ ageMinutes, contextTokens, onSummarize, onFull, onNever }: Props) {
  return (
    <div
      style={{
        maxWidth: 768,
        margin: '0 auto 8px',
        border: '1px solid var(--color-border)',
        borderLeft: '2px solid var(--color-accent)',
        borderRadius: 10,
        background: 'var(--color-elevated)',
        padding: '11px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 9,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Sparkle size={14} weight="fill" color="var(--color-accent)" style={{ flexShrink: 0 }} />
        <span style={{ font: '600 12.5px var(--font-sans)', color: 'var(--color-text-primary)' }}>
          This session is {formatAge(ageMinutes)} old and {contextTokens.toLocaleString()} tokens.
        </span>
      </div>
      <div style={{ font: '400 12.5px var(--font-sans)', lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>
        Resuming the full session will consume a substantial portion of your usage limits.
        Summarizing first keeps every later turn lean.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <button
          onClick={onSummarize}
          style={{ border: 'none', borderRadius: 7, padding: '6px 13px', cursor: 'pointer', background: 'var(--color-accent)', color: '#06140B', font: '600 12.5px var(--font-sans)' }}
        >
          Resume from summary
        </button>
        <button
          onClick={onFull}
          style={{ border: '1px solid var(--color-border)', borderRadius: 7, padding: '6px 13px', cursor: 'pointer', background: 'transparent', color: 'var(--color-text-secondary)', font: '500 12.5px var(--font-sans)' }}
        >
          Resume full session
        </button>
        <button
          onClick={onNever}
          style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', font: '400 11.5px var(--font-sans)' }}
        >
          Don't ask again
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C packages/web test -- ResumeAdviceCard`
Expected: PASS, all seven cases.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/tabs/chat/ResumeAdviceCard.tsx packages/web/src/components/tabs/chat/ResumeAdviceCard.test.tsx
git commit -m "feat(web): ResumeAdviceCard — summarize-before-resume choice for Pretty"
```

---

## Task 5: Wire the card into ChatView

**Files:**
- Modify: `packages/web/src/components/tabs/chat/ChatView.tsx`
- Test: `packages/web/src/components/tabs/chat/ChatView.test.tsx`

**Interfaces:**
- Consumes: `api.getResumeAdvice` and `api.compactTerminal` (Task 3 / existing client), `useSettings().resumeAdviceDismissed` / `.setResumeAdviceDismissed` (Task 3), `<ResumeAdviceCard>` (Task 4).
- Produces: no new exports.

**Note — do NOT use the `compact` callback from `useStructuredChat`.** It is fire-and-forget
(`api.compactTerminal(terminalId).catch(() => {})`, `useStructuredChat.ts:667`), which would
swallow the 409 the endpoint returns when no live structured session backs the thread. The
spec requires that failure to surface, so this task calls `api.compactTerminal` directly and
handles the rejection.

- [ ] **Step 1: Write the failing test**

```tsx
it('offers the resume choice for an old, large thread and compacts on accept', async () => {
  vi.spyOn(api, 'getResumeAdvice').mockResolvedValue({ shouldPrompt: true, ageMinutes: 4560, contextTokens: 134_000 });
  const compactTerminal = vi.spyOn(api, 'compactTerminal').mockResolvedValue(undefined as never);
  render(<ChatView terminalId="t1" />);
  fireEvent.click(await screen.findByRole('button', { name: /resume from summary/i }));
  expect(compactTerminal).toHaveBeenCalledWith('t1');
  await waitFor(() => expect(screen.queryByRole('button', { name: /resume from summary/i })).toBeNull());
});

it('does not offer the resume choice when the daemon says not to', async () => {
  vi.spyOn(api, 'getResumeAdvice').mockResolvedValue({ shouldPrompt: false, ageMinutes: 0, contextTokens: 0 });
  render(<ChatView terminalId="t1" />);
  await waitFor(() => expect(screen.queryByRole('button', { name: /resume from summary/i })).toBeNull());
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C packages/web test -- ChatView`
Expected: FAIL — no "Resume from summary" button is rendered.

- [ ] **Step 3: Add the imports**

In `packages/web/src/components/tabs/chat/ChatView.tsx`, after the existing `InsightText` import (line 16):

```tsx
import { ResumeAdviceCard } from './ResumeAdviceCard';
```

`useSettings` (line 12) and `api` (line 5) are already imported — the new fields are read
off the existing `useSettings` hook inside the component, so no other import changes.

- [ ] **Step 4: Add the state and fetch**

Inside the `ChatView` component, after the `useStructuredChat` destructure (line 49):

```tsx
  const resumeAdviceDismissed = useSettings((s) => s.resumeAdviceDismissed);
  const setResumeAdviceDismissed = useSettings((s) => s.setResumeAdviceDismissed);
  // Advice is about THIS resume, so "not now" lives in component state rather than
  // storage: a later resume of the same thread (older and larger still) should ask again.
  const [advice, setAdvice] = useState<{ ageMinutes: number; contextTokens: number } | null>(null);
  const [adviceError, setAdviceError] = useState<string | null>(null);

  useEffect(() => {
    if (resumeAdviceDismissed) { setAdvice(null); return; }
    let cancelled = false;
    api.getResumeAdvice(terminalId)
      .then((a) => { if (!cancelled && a.shouldPrompt) setAdvice({ ageMinutes: a.ageMinutes, contextTokens: a.contextTokens }); })
      .catch(() => { /* advisory only — never block the chat on it */ });
    return () => { cancelled = true; };
  }, [terminalId, resumeAdviceDismissed]);
```

Add `useEffect` to the React import on line 1 if it is not already there.

- [ ] **Step 5: Render the card**

Immediately before the `{/* thin status row: muted context-window fill indicator… */}` block (line ~269), inside the same composer container:

```tsx
        {adviceError && (
          <div style={{ maxWidth: 768, margin: '0 auto 8px', font: '400 12px var(--font-sans)', color: 'var(--color-status-red)' }}>
            Couldn't summarize: {adviceError}
          </div>
        )}
        {advice && (
          <ResumeAdviceCard
            ageMinutes={advice.ageMinutes}
            contextTokens={advice.contextTokens}
            onSummarize={() => {
              // Direct call, not useStructuredChat's fire-and-forget `compact()`: a thread
              // whose structured session isn't live answers 409, and that must be visible
              // rather than looking like a summarization that quietly did nothing.
              setAdvice(null);
              setAdviceError(null);
              api.compactTerminal(terminalId).catch((e: any) => setAdviceError(e?.message ?? String(e)));
            }}
            onFull={() => setAdvice(null)}
            onNever={() => { setResumeAdviceDismissed(true); setAdvice(null); }}
          />
        )}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm -C packages/web test -- ChatView`
Expected: PASS — both new cases plus every pre-existing ChatView case, including the scroll-preservation ones.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/tabs/chat/ChatView.tsx packages/web/src/components/tabs/chat/ChatView.test.tsx
git commit -m "feat(web): offer summarize-before-resume when opening an old Pretty thread

Closes the gap where -p threads silently resumed full context."
```

**Part A is complete and shippable at this point.**

---

## Task 6: Lighter collapsed tool row

**Files:**
- Modify: `packages/web/src/components/tabs/ToolCall.tsx`
- Test: `packages/web/src/components/tabs/ToolCall.test.tsx` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no signature change — `<ToolCall tool result onViewFile />` keeps its existing props. Shared by `ChatView` and `ConversationView`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolCall } from './ToolCall';
import type { ConvItem } from '../../api/types';

const tool: ConvItem = { kind: 'tool', toolId: 'x1', toolName: 'Bash', toolTitle: 'Bash', toolDetail: 'pnpm test', toolInput: 'pnpm test' } as ConvItem;
const result: ConvItem = { kind: 'tool-result', toolId: 'x1', text: 'ok\nok' } as ConvItem;

describe('ToolCall', () => {
  it('shows the tool detail as a subject on the collapsed row', () => {
    render(<ToolCall tool={tool} result={result} />);
    expect(screen.getByText('pnpm test')).toBeTruthy();
  });

  it('renders the collapsed row without card chrome', () => {
    const { container } = render(<ToolCall tool={tool} result={result} />);
    const row = container.firstElementChild as HTMLElement;
    expect(row.style.border).toBe('');
    expect(row.style.background).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C packages/web test -- ToolCall`
Expected: FAIL — `pnpm test` is not rendered, and the wrapper still carries border/background.

- [ ] **Step 3: Move the chrome off the row and onto the shelf**

In `packages/web/src/components/tabs/ToolCall.tsx`, replace the outer wrapper (line 32) — chrome no longer lives on the collapsed row:

```tsx
    <div style={{ borderRadius: 9, overflow: 'hidden' }}>
```

Replace the header `<button>` style (line 35) to add hover affordance and tighter padding:

```tsx
        style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: expandable ? 'pointer' : 'default', padding: '4px 6px', borderRadius: 7, display: 'flex', gap: 7, alignItems: 'center' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-hover)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
```

Add the subject between the name span (line 39) and the status span (line 40):

```tsx
        {tool.toolDetail && (
          <span
            title={tool.toolDetail}
            style={{ minWidth: 0, flex: '1 1 auto', fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {tool.toolDetail}
          </span>
        )}
```

and change the name span (line 39) from `flex: 1` to `flex: '0 1 auto'` so the subject takes the slack:

```tsx
        <span style={{ minWidth: 0, flex: '0 1 auto', fontSize: 12.5, color: 'var(--color-text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{headerName}</span>
```

Finally, put the chrome on the expanded shelf (line 45) so the open state still reads as a panel:

```tsx
        <div style={{ border: '1px solid var(--color-border)', borderRadius: 8, background: 'var(--color-elevated)', overflow: 'hidden', marginTop: 4 }}>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C packages/web test`
Expected: PASS — the two new cases plus all pre-existing web tests, including `ConversationView`'s.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/tabs/ToolCall.tsx packages/web/src/components/tabs/ToolCall.test.tsx
git commit -m "feat(web): lighter tool rows — chrome moves to the expanded shelf

Collapsed rows lose their box and gain the toolDetail subject that was
already in the data but never rendered. Shared by Pretty and View mode."
```

---

## Task 7: Group consecutive same-tool runs in ChatView

**Files:**
- Modify: `packages/web/src/components/tabs/chat/ChatView.tsx`
- Test: `packages/web/src/components/tabs/chat/ChatView.test.tsx`

**Interfaces:**
- Consumes: `<ToolCall>` (Task 6), the existing `stableId(it)`, `useToolExpanded` (`../../../hooks/useToolUIState`).
- Produces: an internal `ToolGroup` component. `renderTimeline(items, onViewFile, pageBoundaries)` keeps its exact signature.

- [ ] **Step 1: Write the failing test**

```tsx
const read = (id: string, file: string, lines: number) => [
  { kind: 'tool', toolId: id, toolName: 'Read', toolTitle: `Read ${file}`, toolDetail: file, toolInput: '{}' },
  { kind: 'tool-result', toolId: id, text: Array(lines).fill('x').join('\n') },
] as ConvItem[];

it('collapses a run of same-tool calls into one row', () => {
  const items = [...read('a', 'one.ts', 3), ...read('b', 'two.ts', 3), ...read('c', 'three.ts', 3)];
  render(<>{renderTimeline(items, () => {}, new Set())}</>);
  expect(screen.getByText('Read 3 files')).toBeTruthy();
  expect(screen.queryByText('one.ts')).toBeNull();
});

it('expands the group to the individual calls', () => {
  const items = [...read('a', 'one.ts', 3), ...read('b', 'two.ts', 3), ...read('c', 'three.ts', 3)];
  render(<>{renderTimeline(items, () => {}, new Set())}</>);
  fireEvent.click(screen.getByText('Read 3 files'));
  expect(screen.getByText('one.ts')).toBeTruthy();
  expect(screen.getByText('three.ts')).toBeTruthy();
});

it('does not group different tools', () => {
  const items = [...read('a', 'one.ts', 3), { kind: 'tool', toolId: 'b', toolName: 'Bash', toolTitle: 'Bash', toolDetail: 'ls' } as ConvItem];
  render(<>{renderTimeline(items, () => {}, new Set())}</>);
  expect(screen.queryByText(/Read \d files/)).toBeNull();
});

it('does not group a lone tool call', () => {
  render(<>{renderTimeline(read('a', 'one.ts', 3), () => {}, new Set())}</>);
  expect(screen.queryByText(/Read \d files/)).toBeNull();
  expect(screen.getByText('one.ts')).toBeTruthy();
});

it('breaks a group at a page boundary so prepends cannot merge into it', () => {
  const items = [...read('a', 'one.ts', 3), ...read('b', 'two.ts', 3)];
  render(<>{renderTimeline(items, () => {}, new Set([items[2]]))}</>);
  expect(screen.queryByText(/Read \d files/)).toBeNull();
});

it('renders a group expanded while a member is still running', () => {
  const items = [...read('a', 'one.ts', 3), { kind: 'tool', toolId: 'b', toolName: 'Read', toolTitle: 'Read two.ts', toolDetail: 'two.ts' } as ConvItem];
  render(<>{renderTimeline(items, () => {}, new Set())}</>);
  expect(screen.getByText('one.ts')).toBeTruthy();
  expect(screen.getByText('two.ts')).toBeTruthy();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C packages/web test -- ChatView`
Expected: FAIL — "Read 3 files" is not rendered; every tool renders standalone.

- [ ] **Step 3: Add the `ToolGroup` component**

In `packages/web/src/components/tabs/chat/ChatView.tsx`, next to `AssistantTurn` (line ~389). Import `useToolExpanded` at the top:

```tsx
import { useToolExpanded } from '../../../hooks/useToolUIState';
```

```tsx
/**
 * A run of consecutive same-tool calls, collapsed to one row. Six Reads in a turn
 * would otherwise be six separate rows that bury the assistant's prose.
 *
 * While any member is still running the group renders EXPANDED so live work stays
 * visible, then collapses once the whole run settles. `useToolExpanded` persists a
 * manual toggle per id, so once the reader opens or closes it their choice wins.
 *
 * Expansion state is keyed off the FIRST member's id, which is immutable as a run
 * grows — the group's React key is anchored to its LAST item by renderTimeline, for
 * the scroll-preservation reasons documented there.
 */
function ToolGroup({ tools, resultById, onViewFile }: { tools: ConvItem[]; resultById: Map<string, ConvItem>; onViewFile: (p: string) => void }) {
  const firstId = tools[0].uuid ?? tools[0].toolId;
  const running = tools.some((t) => !t.toolId || !resultById.has(t.toolId));
  const [open, setOpen] = useToolExpanded(firstId ? `group:${firstId}` : undefined, false);
  const expanded = open || running;
  const label = `${tools[0].toolName} ${tools.length} ${tools.length === 1 ? 'call' : 'calls'}`;
  // "Read 3 files" reads better than "Read 3 calls" for the file-shaped tools.
  const fileish = tools[0].toolName === 'Read' || tools[0].toolName === 'Write' || tools[0].toolName === 'Edit';
  const heading = fileish ? `${tools[0].toolName} ${tools.length} files` : label;
  const lines = tools.reduce((n, t) => n + (t.toolId ? (resultById.get(t.toolId)?.text?.split('\n').length ?? 0) : 0), 0);

  if (expanded) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <GroupHeader heading={heading} lines={lines} running={running} open onClick={() => setOpen(false)} />
        <div style={{ paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {tools.map((t) => (
            <ToolCall key={t.uuid ?? t.toolId} tool={t} result={t.toolId ? resultById.get(t.toolId) : undefined} onViewFile={onViewFile} />
          ))}
        </div>
      </div>
    );
  }
  return <GroupHeader heading={heading} lines={lines} running={false} open={false} onClick={() => setOpen(true)} />;
}

function GroupHeader({ heading, lines, running, open, onClick }: { heading: string; lines: number; running: boolean; open: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: 7, display: 'flex', gap: 7, alignItems: 'center' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-hover)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
    >
      <CaretRight size={11} weight="bold" style={{ flexShrink: 0, color: 'var(--color-text-tertiary)', transition: 'transform .12s ease', transform: open ? 'rotate(90deg)' : 'none' }} />
      <Wrench size={13} color="#5A8DD6" style={{ flexShrink: 0 }} />
      <span style={{ minWidth: 0, flex: 1, fontSize: 12.5, color: 'var(--color-text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{heading}</span>
      {running
        ? <span className="chat-shimmer" style={{ flexShrink: 0, fontSize: 11 }}>running…</span>
        : <span style={{ flexShrink: 0, fontSize: 11, color: 'var(--color-text-secondary)' }}>{lines} line{lines !== 1 ? 's' : ''}</span>}
    </button>
  );
}
```

Add `Wrench` to the `@phosphor-icons/react` import on line 3.

- [ ] **Step 4: Add the grouping pass to `renderTimeline`**

In `renderTimeline`, replace the `else if (it.kind === 'tool')` branch (lines 350-366) with a version that first looks ahead for a run. Insert this immediately before that branch:

```tsx
    // Look ahead for a run of consecutive same-tool calls (ignoring their interleaved
    // results, which are rendered paired). A run of 2+ collapses into one ToolGroup.
    // AskUserQuestion is excluded — it has live-overlay special-casing below.
    if (it.kind === 'tool' && it.toolName !== 'AskUserQuestion') {
      const run: ConvItem[] = [it];
      let j = i + 1;
      for (; j < items.length; j++) {
        const nxt = items[j];
        if (nxt.kind === 'tool-result') continue;              // paired result, not a break
        if (pageBoundaries.has(nxt)) break;                    // a prepend must not merge in
        if (nxt.kind !== 'tool' || nxt.toolName !== it.toolName) break;
        if (nxt.toolName === 'AskUserQuestion') break;
        run.push(nxt);
      }
      if (run.length > 1) {
        const groupNode = <ToolGroup tools={run} resultById={resultById} onViewFile={onViewFile} />;
        const lastId = stableId(run[run.length - 1]);
        if (!group) group = { key: lastId, nodes: [] };
        group.key = lastId;
        group.nodes.push(<div key={lastId}>{groupNode}</div>);
        // Skip past the run's members; their paired results are skipped by the
        // existing `toolIds.has(...)` guard on the 'tool-result' branch.
        i = items.indexOf(run[run.length - 1]);
        continue;
      }
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm -C packages/web test -- ChatView`
Expected: PASS — all six new cases plus every pre-existing ChatView case, **including the scroll-preservation tests**. If any pre-existing test fails, the grouping pass has broken key stability; fix it there rather than editing the test.

- [ ] **Step 6: Run the whole suite and build**

Run: `pnpm -C packages/web test && pnpm -C packages/core test && pnpm build`
Expected: PASS on all three.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/tabs/chat/ChatView.tsx packages/web/src/components/tabs/chat/ChatView.test.tsx
git commit -m "feat(web): group consecutive same-tool runs in Pretty

A run of 2+ same-tool calls collapses to one row, expanding to the
individual calls. Groups break at page boundaries so loadOlder prepends
cannot merge into an existing group and defeat scroll preservation."
```

---

## Verification before finishing

- [ ] `pnpm -C packages/core test` — green
- [ ] `pnpm -C packages/web test` — green
- [ ] `pnpm build` — clean
- [ ] Manual: open an old, large Pretty thread; confirm the card appears, "Resume from summary" triggers compaction, and "Don't ask again" survives a reload
- [ ] Manual: confirm View mode on a CLI thread still renders tool calls correctly after the shared restyle
