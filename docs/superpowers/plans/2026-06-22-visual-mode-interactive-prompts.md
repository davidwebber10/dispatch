# Visual Mode Interactive Prompts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Visual mode (the chat-style thread view) never-stuck by surfacing every interactive terminal prompt (resume picker, trust-folder, approvals, model questions) as a one-tap control, with a real-terminal fallback for anything unparsable.

**Architecture:** A pure `detectPrompt(provider, screen)` parses the live PTY screen (from `ptyManager.getBuffer`) into a normalized `DetectedPrompt`. A `PromptService` debounces PTY output, runs detection when a thread goes quiet, dedupes, and broadcasts a `terminal:prompt` websocket event. The web renders a `PromptCard` (option buttons) or, when `parsed=false`, an inline live terminal. Answering sends keystrokes through the existing `POST /api/terminals/:id/input`. Detection runs server-side regardless of whether Visual mode is open.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Express, ws, better-sqlite3, node-pty, vitest (core); React + Zustand + Vite, vitest (web). pnpm workspace.

## Global Constraints

- ESM throughout; **import specifiers end in `.js`** even for `.ts` sources.
- TDD: write the failing test, watch it fail, minimal code, watch it pass, commit.
- The daemon runs the **built** `packages/core/dist/server.js` under node ≥18 — `dispatch build` before `dispatch restart`.
- Normalized model is provider-agnostic: the web never sees Claude/Codex specifics.
- Nothing is auto-answered — every detected prompt is surfaced.
- Deploy order: mini (`ssh mini 'zsh -ilc "cd ~/Sites/dispatch && ./bin/dispatch update"'`) → MacBook last (`./bin/dispatch restart`, which ends the session).
- Internal mode keys stay `normal`/`expert`; the Pretty→Visual change is display-only.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/core/src/status/screen.ts` (create) | `stripAnsi` + `lastScreen` helpers (pure) |
| `packages/core/src/status/prompt.ts` (create) | `detectPrompt(provider, screen)` + per-provider parsers (pure) |
| `packages/core/src/status/prompt-service.ts` (create) | `PromptService`: debounce → detect → dedupe → broadcast |
| `packages/core/src/server.ts` (modify) | construct `PromptService`, call `onOutput` in the data handler, `clear` on exit |
| `packages/core/tests/status/screen.test.ts` (create) | screen helper tests |
| `packages/core/tests/status/prompt.test.ts` (create) | parser tests against captured fixtures |
| `packages/core/tests/status/prompt-service.test.ts` (create) | dedupe/clear/broadcast tests |
| `packages/core/tests/fixtures/prompts/*.txt` (create) | captured raw prompt screens |
| `packages/web/src/stores/prompts.ts` (create) | `usePrompts` store from `terminal:prompt` events |
| `packages/web/src/stores/prompts.test.ts` (create) | store tests |
| `packages/web/src/components/tabs/PromptCard.tsx` (create) | renders option buttons / inline-terminal fallback |
| `packages/web/src/components/tabs/ConversationView.tsx` (modify) | mount `PromptCard` above the composer |
| `packages/web/src/components/tabs/TabHost.tsx` (modify) | rename label Pretty→Visual |
| `packages/web/src/App.tsx` (modify) | register the prompts store on the event bus |

---

## Task 1: Capture live prompt fixtures

Real on-screen bytes are the ground truth for every parser. Capture them with a tiny node-pty harness, one file per prompt, committed as both fixtures and regression inputs.

**Files:**
- Create: `packages/core/scripts/capture-prompt.mjs`
- Create (output): `packages/core/tests/fixtures/prompts/claude-trust-folder.txt`, `claude-resume-picker.txt`, `claude-select.txt`, `claude-confirm.txt`, `codex-approval.txt`, `codex-select.txt`

**Interfaces:**
- Produces: fixture `.txt` files (raw screen incl. ANSI) consumed by Tasks 3–4.

- [ ] **Step 1: Write the capture harness**

```js
// packages/core/scripts/capture-prompt.mjs
// Usage: node capture-prompt.mjs "<command>" <secondsToRun> > fixture.txt
// Spawns the command in a PTY, echoes everything it emits to stdout, and exits
// after N seconds (or on exit). Pipe stdout to a fixture file, then trigger the
// prompt interactively in another pane if needed. Captures raw ANSI verbatim.
import pty from 'node-pty';
const [, , command, secs = '8'] = process.argv;
const proc = pty.spawn('/bin/zsh', ['-ilc', command], { name: 'xterm-256color', cols: 120, rows: 40, cwd: process.cwd(), env: process.env });
proc.onData((d) => process.stdout.write(d));
setTimeout(() => { try { proc.kill(); } catch {} process.exit(0); }, Number(secs) * 1000);
proc.onExit(() => process.exit(0));
```

- [ ] **Step 2: Capture each Claude prompt**

Run each in a scratch dir and let the harness record the screen at the prompt:

```bash
cd packages/core
# trust-folder: a never-trusted dir triggers the trust prompt
TMP=$(mktemp -d); node scripts/capture-prompt.mjs "cd $TMP && claude" 6 > tests/fixtures/prompts/claude-trust-folder.txt
# resume picker (lists prior sessions, ❯-highlighted)
node scripts/capture-prompt.mjs "claude --resume" 6 > tests/fixtures/prompts/claude-resume-picker.txt
```

For `claude-select.txt` (a model-asked multiple-choice / a slash menu like `/model`) and `claude-confirm.txt` (a `(y/n)`), trigger the prompt in a real Dispatch thread, then copy the on-screen text into the fixture file. If a given prompt can't be triggered, create the file with the smallest faithful excerpt you *can* observe and note it in a comment line prefixed `# source:`.

- [ ] **Step 3: Capture each Codex prompt**

```bash
# Codex approval prompt: run a tool-using task without bypass so it asks to approve
node scripts/capture-prompt.mjs "codex" 6 > tests/fixtures/prompts/codex-approval.txt
```

Capture `codex-select.txt` similarly (Codex's selection/menu framing).

- [ ] **Step 4: Sanity-check the fixtures**

Run: `for f in tests/fixtures/prompts/*.txt; do echo "== $f =="; wc -c "$f"; done`
Expected: each file non-empty and contains the prompt text (e.g. grep for "trust", "❯", "(y/n)", "resume").

- [ ] **Step 5: Commit**

```bash
git add packages/core/scripts/capture-prompt.mjs packages/core/tests/fixtures/prompts
git commit -m "test(prompts): capture live Claude/Codex prompt screen fixtures"
```

---

## Task 2: Screen helpers (strip ANSI + last screen)

**Files:**
- Create: `packages/core/src/status/screen.ts`
- Test: `packages/core/tests/status/screen.test.ts`

**Interfaces:**
- Produces: `stripAnsi(s: string): string`, `lastScreen(raw: string, maxLines?: number): string` (consumed by Tasks 3–5).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/status/screen.test.ts
import { describe, it, expect } from 'vitest';
import { stripAnsi, lastScreen } from '../../src/status/screen.js';

describe('stripAnsi', () => {
  it('removes CSI color codes and OSC sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    expect(stripAnsi('\x1b]0;title\x07ok')).toBe('ok');
  });
});

describe('lastScreen', () => {
  it('returns the trailing N non-empty-trimmed lines, ansi-stripped', () => {
    const raw = 'a\n\x1b[32mb\x1b[0m\nc\nd\n';
    expect(lastScreen(raw, 2)).toBe('c\nd');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/status/screen.test.ts`
Expected: FAIL — cannot find module `../../src/status/screen.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/status/screen.ts
/** Strip ANSI CSI color/cursor codes + OSC title sequences from terminal output. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z]/g, '');
}

/** The trailing screen region: last `maxLines` lines, ansi-stripped, right-trimmed. */
export function lastScreen(raw: string, maxLines = 40): string {
  const lines = stripAnsi(raw).split('\n').map((l) => l.replace(/\s+$/, ''));
  return lines.slice(-maxLines).join('\n').replace(/^\n+|\n+$/g, '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/status/screen.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/status/screen.ts packages/core/tests/status/screen.test.ts
git commit -m "feat(prompts): screen helpers (stripAnsi + lastScreen)"
```

---

## Task 3: detectPrompt + Claude parsers

Write parsers against the **real fixtures from Task 1**. The code below matches Claude's documented TUI shapes (box frames, `❯` cursor, numbered options, `(y/n)`); after wiring the fixture into the test, adjust the literal match strings to the captured text if they differ.

**Files:**
- Create: `packages/core/src/status/prompt.ts`
- Test: `packages/core/tests/status/prompt.test.ts`

**Interfaces:**
- Consumes: `stripAnsi`, `lastScreen` (Task 2); fixtures (Task 1).
- Produces: `interface PromptOption { label: string; keys: string }`, `interface DetectedPrompt { kind: string; question: string; options: PromptOption[]; parsed: boolean; raw?: string }`, `detectPrompt(provider: string, screen: string): DetectedPrompt | null`.

- [ ] **Step 1: Write the failing test (Claude)**

```ts
// packages/core/tests/status/prompt.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { detectPrompt } from '../../src/status/prompt.js';

const fx = (name: string) => fs.readFileSync(path.join(__dirname, '../fixtures/prompts', name), 'utf8');

describe('detectPrompt (claude)', () => {
  it('returns null for a non-prompt screen', () => {
    expect(detectPrompt('claude-code', 'just some assistant output\n> ')).toBeNull();
  });

  it('detects the trust-folder prompt with Yes/No options', () => {
    const p = detectPrompt('claude-code', fx('claude-trust-folder.txt'))!;
    expect(p.kind).toBe('trust-folder');
    expect(p.question.toLowerCase()).toContain('trust');
    expect(p.options.map((o) => o.label.toLowerCase()).join('|')).toMatch(/yes|proceed/);
    expect(p.parsed).toBe(true);
  });

  it('detects a (y/n) confirm', () => {
    const p = detectPrompt('claude-code', 'Continue? (y/n)')!;
    expect(p.kind).toBe('confirm');
    expect(p.options).toEqual([
      { label: 'Yes', keys: 'y' },
      { label: 'No', keys: 'n' },
    ]);
  });

  it('detects a numbered select menu and maps each option to its digit', () => {
    const screen = 'Which approach?\n❯ 1. MVP first\n  2. Risk first\n  3. User first';
    const p = detectPrompt('claude-code', screen)!;
    expect(p.kind).toBe('select');
    expect(p.question).toBe('Which approach?');
    expect(p.options).toEqual([
      { label: 'MVP first', keys: '1' },
      { label: 'Risk first', keys: '2' },
      { label: 'User first', keys: '3' },
    ]);
  });

  it('flags an unparsable prompt-looking screen for fallback', () => {
    const p = detectPrompt('claude-code', 'Pick a file:\n❯ ~/some/weird/tui/we/cannot/parse')!;
    expect(p.parsed).toBe(false);
    expect(p.raw).toContain('Pick a file');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/status/prompt.test.ts`
Expected: FAIL — cannot find module `../../src/status/prompt.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/status/prompt.ts
import { lastScreen } from './screen.js';

export interface PromptOption { label: string; keys: string }
export interface DetectedPrompt {
  kind: string;
  question: string;
  options: PromptOption[];
  parsed: boolean;
  raw?: string;
}

// A screen is "prompt-shaped" if it carries a selection cursor, a (y/n), or a
// numbered option list. The bare REPL box must NOT match.
function looksLikePrompt(screen: string): boolean {
  return /❯/.test(screen) || /\(y\/n\)/i.test(screen) || /^\s*\d+\.\s+\S/m.test(screen);
}

type Parser = (screen: string) => DetectedPrompt | null;

const trustFolder: Parser = (s) => {
  if (!/trust the files in this folder/i.test(s)) return null;
  const question = (s.split('\n').find((l) => /trust the files/i.test(l)) || 'Do you trust the files in this folder?').trim();
  // Claude trust prompt is a numbered menu: 1) trust/proceed, 2) no/exit.
  return {
    kind: 'trust-folder',
    question,
    options: [
      { label: 'Yes, proceed', keys: '1' },
      { label: 'No', keys: '2' },
    ],
    parsed: true,
  };
};

const confirm: Parser = (s) => {
  const line = s.split('\n').reverse().find((l) => /\(y\/n\)/i.test(l));
  if (!line) return null;
  return {
    kind: 'confirm',
    question: line.replace(/\(y\/n\)\s*$/i, '').trim() || 'Confirm?',
    options: [
      { label: 'Yes', keys: 'y' },
      { label: 'No', keys: 'n' },
    ],
    parsed: true,
  };
};

const numberedSelect: Parser = (s) => {
  const lines = s.split('\n');
  const items: PromptOption[] = [];
  for (const l of lines) {
    const m = l.match(/^\s*[❯>]?\s*(\d+)[.)]\s+(.+?)\s*$/);
    if (m) items.push({ label: m[2].trim(), keys: m[1] });
  }
  if (items.length < 2) return null;
  // Question = the last non-empty line above the first option that isn't an option.
  const firstIdx = lines.findIndex((l) => /^\s*[❯>]?\s*\d+[.)]\s+/.test(l));
  const question = lines.slice(0, firstIdx).map((l) => l.trim()).filter(Boolean).pop() || 'Choose an option';
  return { kind: 'select', question, options: items, parsed: true };
};

const CLAUDE_PARSERS: Parser[] = [trustFolder, confirm, numberedSelect];
const CODEX_PARSERS: Parser[] = []; // Task 4

export function detectPrompt(provider: string, raw: string): DetectedPrompt | null {
  const screen = lastScreen(raw);
  if (!looksLikePrompt(screen)) return null;
  const parsers = provider === 'codex' ? CODEX_PARSERS : CLAUDE_PARSERS;
  for (const p of parsers) {
    const hit = p(screen);
    if (hit) return hit;
  }
  // Prompt-shaped but unparsed → fallback to inline terminal.
  const question = screen.split('\n').map((l) => l.trim()).filter(Boolean)[0] || 'The agent is asking for input';
  return { kind: 'unknown', question, options: [], parsed: false, raw: screen };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/status/prompt.test.ts`
Expected: PASS. If the `claude-trust-folder.txt` fixture's wording differs from the regex, adjust the literal in `trustFolder`/the test to the captured text (the fixture is ground truth), then re-run.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/status/prompt.ts packages/core/tests/status/prompt.test.ts
git commit -m "feat(prompts): detectPrompt + Claude parsers (trust/confirm/select + fallback)"
```

---

## Task 4: Codex parsers

Add Codex's TUI shapes to `detectPrompt`, validated against `codex-approval.txt` / `codex-select.txt`.

**Files:**
- Modify: `packages/core/src/status/prompt.ts`
- Test: `packages/core/tests/status/prompt.test.ts`

**Interfaces:**
- Consumes: `DetectedPrompt`, `Parser` shape (Task 3).
- Produces: populated `CODEX_PARSERS`.

- [ ] **Step 1: Write the failing test (Codex)**

```ts
// append to tests/status/prompt.test.ts
describe('detectPrompt (codex)', () => {
  it('detects a codex approval prompt', () => {
    const p = detectPrompt('codex', fx('codex-approval.txt'))!;
    expect(p.parsed).toBe(true);
    expect(p.options.length).toBeGreaterThanOrEqual(2);
    expect(p.options.map((o) => o.label.toLowerCase()).join('|')).toMatch(/allow|yes|approve|run/);
  });

  it('detects a codex numbered select', () => {
    const p = detectPrompt('codex', fx('codex-select.txt'))!;
    expect(p.kind).toBe('select');
    expect(p.options.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/status/prompt.test.ts`
Expected: FAIL — codex tests fail (CODEX_PARSERS empty → approval returns `parsed:false`).

- [ ] **Step 3: Write minimal implementation**

Write the Codex parsers against the captured fixtures. The `numberedSelect` from Task 3 is provider-agnostic, so reuse it; add a Codex approval parser keyed on its wording. Example (adjust literals/keys to `codex-approval.txt`):

```ts
// in prompt.ts — add above the CODEX_PARSERS line
const codexApproval: Parser = (s) => {
  if (!/(allow command|approve|do you want to run|requires approval)/i.test(s)) return null;
  const question = (s.split('\n').map((l) => l.trim()).filter(Boolean).find((l) => /approve|allow|run/i.test(l))) || 'Approve this action?';
  // Map to the keys Codex's approval menu accepts (confirm against the fixture).
  return {
    kind: 'permission',
    question,
    options: [
      { label: 'Allow', keys: 'y' },
      { label: 'Deny', keys: 'n' },
    ],
    parsed: true,
  };
};

const CODEX_PARSERS: Parser[] = [codexApproval, confirm, numberedSelect];
```

Replace the empty `const CODEX_PARSERS: Parser[] = [];` from Task 3 with this populated array (and move `numberedSelect`/`confirm` declarations above it if needed).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/status/prompt.test.ts`
Expected: PASS. Adjust `codexApproval` literals + option `keys` to match `codex-approval.txt` if the assertions fail.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/status/prompt.ts packages/core/tests/status/prompt.test.ts
git commit -m "feat(prompts): Codex prompt parsers (approval + select)"
```

---

## Task 5: PromptService (debounce → detect → dedupe → broadcast)

**Files:**
- Create: `packages/core/src/status/prompt-service.ts`
- Test: `packages/core/tests/status/prompt-service.test.ts`

**Interfaces:**
- Consumes: `detectPrompt` (Task 3/4); `terminalsDb.getById`; `ptyManager.getBuffer`; `EventBroadcaster`.
- Produces: `class PromptService { constructor(db, ptyManager, broadcaster); check(terminalId: string): void; clear(terminalId: string): void }`. Broadcasts `{ type: 'terminal:prompt', terminalId, prompt: DetectedPrompt | null }`.

Note: `check` is synchronous and testable directly; the debounce wrapper (`onOutput`) is added in Task 6 where the real PTY data flow lives (kept out of the unit so tests don't need timers).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/status/prompt-service.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { PromptService } from '../../src/status/prompt-service.js';

let db: Database.Database;
let broadcaster: { broadcast: ReturnType<typeof vi.fn> };
let buffers: Record<string, string>;
const ptyManager = { getBuffer: (id: string) => buffers[id] ?? '' } as any;

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 'proj', provider: 'claude-code', name: 'p', workingDir: '/x' });
  terminalsDb.create(db, { id: 'term', sessionId: 'proj', type: 'claude-code', label: 't', skipPermissions: true });
  broadcaster = { broadcast: vi.fn() };
  buffers = {};
});

const prompts = () => broadcaster.broadcast.mock.calls.map((c) => c[0]).filter((e: any) => e.type === 'terminal:prompt');

describe('PromptService', () => {
  it('broadcasts a detected prompt', () => {
    buffers['term'] = 'Continue? (y/n)';
    new PromptService(db, ptyManager, broadcaster).check('term');
    expect(prompts().at(-1)).toMatchObject({ terminalId: 'term', prompt: { kind: 'confirm' } });
  });

  it('does not re-broadcast an unchanged prompt', () => {
    buffers['term'] = 'Continue? (y/n)';
    const s = new PromptService(db, ptyManager, broadcaster);
    s.check('term'); s.check('term');
    expect(prompts()).toHaveLength(1);
  });

  it('broadcasts null when the prompt clears (screen advanced)', () => {
    buffers['term'] = 'Continue? (y/n)';
    const s = new PromptService(db, ptyManager, broadcaster);
    s.check('term');
    buffers['term'] = 'thinking...\nassistant text now\n> ';
    s.check('term');
    expect(prompts().at(-1)).toEqual({ type: 'terminal:prompt', terminalId: 'term', prompt: null });
  });

  it('clear() emits null only if a prompt was active', () => {
    const s = new PromptService(db, ptyManager, broadcaster);
    s.clear('term');
    expect(prompts()).toHaveLength(0);
  });

  it('ignores unknown terminals', () => {
    expect(() => new PromptService(db, ptyManager, broadcaster).check('nope')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/status/prompt-service.test.ts`
Expected: FAIL — cannot find module `../../src/status/prompt-service.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/status/prompt-service.ts
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import type { PTYManager } from '../pty/manager.js';
import type { EventBroadcaster } from '../ws/events.js';
import { detectPrompt, type DetectedPrompt } from './prompt.js';

/**
 * Detects interactive prompts on a terminal's live screen and broadcasts
 * `terminal:prompt` (or null when it clears). Dedupes so an unchanged prompt
 * isn't re-sent. Stateless except for the last-broadcast signature per terminal.
 */
export class PromptService {
  private active = new Map<string, string>(); // terminalId -> signature of last prompt

  constructor(
    private db: Database.Database,
    private ptyManager: PTYManager,
    private broadcaster: EventBroadcaster,
  ) {}

  check(terminalId: string): void {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return;
    const prompt = detectPrompt(terminal.type, this.ptyManager.getBuffer(terminalId));
    const sig = prompt ? `${prompt.kind}::${prompt.question}::${prompt.parsed}` : '';
    const prev = this.active.get(terminalId) ?? '';
    if (sig === prev) return; // unchanged (incl. still-no-prompt)
    if (prompt) this.active.set(terminalId, sig);
    else this.active.delete(terminalId);
    this.broadcaster.broadcast({ type: 'terminal:prompt', terminalId, prompt });
  }

  /** On terminal exit/removal: clear any active prompt. */
  clear(terminalId: string): void {
    if (!this.active.has(terminalId)) return;
    this.active.delete(terminalId);
    this.broadcaster.broadcast({ type: 'terminal:prompt', terminalId, prompt: null });
  }
}

export type { DetectedPrompt };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/status/prompt-service.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/status/prompt-service.ts packages/core/tests/status/prompt-service.test.ts
git commit -m "feat(prompts): PromptService (detect + dedupe + broadcast terminal:prompt)"
```

---

## Task 6: Wire PromptService into the server

**Files:**
- Modify: `packages/core/src/server.ts` (imports; construct in `startServer`; debounced `onOutput` in the `ptyManager.on('data')` handler; `clear` in `ptyManager.on('exit')`)

**Interfaces:**
- Consumes: `PromptService` (Task 5).
- Produces: live `terminal:prompt` events from the running daemon.

- [ ] **Step 1: Add the import**

In `packages/core/src/server.ts`, after the `import { StatusService } from './status/service.js';` line, add:

```ts
import { PromptService } from './status/prompt-service.js';
```

- [ ] **Step 2: Construct it + add a debounce map (startServer only)**

In `startServer`, right after `const statusService = new StatusService(db, broadcaster);`, add:

```ts
const promptService = new PromptService(db, ptyManager, broadcaster);
const promptTimers = new Map<string, ReturnType<typeof setTimeout>>();
const schedulePromptCheck = (id: string) => {
  const existing = promptTimers.get(id);
  if (existing) clearTimeout(existing);
  promptTimers.set(id, setTimeout(() => { promptTimers.delete(id); try { promptService.check(id); } catch {} }, 600));
};
```

- [ ] **Step 3: Trigger detection on PTY output**

In the existing `ptyManager.on('data', (id, data) => { ... })` handler, add `schedulePromptCheck(id);` as the last line inside the callback (after `agentService.onRunnerData(id, data);`). This debounces a check 600ms after output stops — i.e., when the thread goes quiet at a prompt.

- [ ] **Step 4: Clear on exit**

In the existing `ptyManager.on('exit', (id, exitCode) => { ... })` handler, inside the `if (terminal) { ... }` block (after the existing `broadcaster.broadcast({ type: 'terminal:exit', ... })` line), add:

```ts
      promptService.clear(id);
```

- [ ] **Step 5: Build to verify it compiles**

Run: `cd packages/core && npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 6: Run the full core suite**

Run: `cd packages/core && npx vitest run`
Expected: PASS (all suites green).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/server.ts
git commit -m "feat(prompts): wire PromptService into the PTY data/exit flow (debounced)"
```

---

## Task 7: Web prompts store

**Files:**
- Create: `packages/web/src/stores/prompts.ts`
- Test: `packages/web/src/stores/prompts.test.ts`
- Modify: `packages/web/src/App.tsx` (register on the event bus)

**Interfaces:**
- Consumes: `ServerEvent` (`{ type, [k]: unknown }`).
- Produces: `usePrompts` zustand store with `byTerminal: Record<string, DetectedPrompt | null>` and `applyEvent(e)`. Web-local type `DetectedPrompt` mirrors the core one.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/stores/prompts.test.ts
import { expect, test, beforeEach } from 'vitest';
import { usePrompts } from './prompts';

beforeEach(() => usePrompts.setState({ byTerminal: {} }));

test('stores a prompt from terminal:prompt', () => {
  usePrompts.getState().applyEvent({ type: 'terminal:prompt', terminalId: 't1', prompt: { kind: 'confirm', question: 'Continue?', options: [{ label: 'Yes', keys: 'y' }], parsed: true } });
  expect(usePrompts.getState().byTerminal['t1']).toMatchObject({ kind: 'confirm', parsed: true });
});

test('clears a prompt when prompt is null', () => {
  const s = usePrompts.getState();
  s.applyEvent({ type: 'terminal:prompt', terminalId: 't1', prompt: { kind: 'confirm', question: 'x', options: [], parsed: true } });
  s.applyEvent({ type: 'terminal:prompt', terminalId: 't1', prompt: null });
  expect(usePrompts.getState().byTerminal['t1']).toBeNull();
});

test('ignores unrelated events', () => {
  usePrompts.getState().applyEvent({ type: 'terminal:status', terminalId: 't1', status: 'working' });
  expect(usePrompts.getState().byTerminal).toEqual({});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/stores/prompts.test.ts`
Expected: FAIL — cannot find module `./prompts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/web/src/stores/prompts.ts
import { create } from 'zustand';
import type { ServerEvent } from '../api/events-socket';

export interface PromptOption { label: string; keys: string }
export interface DetectedPrompt {
  kind: string;
  question: string;
  options: PromptOption[];
  parsed: boolean;
  raw?: string;
}

interface PromptsState {
  byTerminal: Record<string, DetectedPrompt | null>;
  applyEvent: (e: ServerEvent) => void;
}

export const usePrompts = create<PromptsState>((set, get) => ({
  byTerminal: {},
  applyEvent: (e) => {
    if (e.type === 'terminal:prompt' && typeof e.terminalId === 'string') {
      set({ byTerminal: { ...get().byTerminal, [e.terminalId]: (e.prompt as DetectedPrompt | null) ?? null } });
    }
  },
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && npx vitest run src/stores/prompts.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Register on the event bus**

In `packages/web/src/App.tsx`: add `import { usePrompts } from './stores/prompts';` next to the other store imports, and add `usePrompts.getState().applyEvent(e);` in the `onEvent` callback next to `useThreadStatus.getState().applyEvent(e);`.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/stores/prompts.ts packages/web/src/stores/prompts.test.ts packages/web/src/App.tsx
git commit -m "feat(web): prompts store + event-bus wiring"
```

---

## Task 8: PromptCard + ConversationView integration

**Files:**
- Create: `packages/web/src/components/tabs/PromptCard.tsx`
- Modify: `packages/web/src/components/tabs/ConversationView.tsx`

**Interfaces:**
- Consumes: `usePrompts` (Task 7); `api.sendInput`; `TerminalTab` (for fallback).
- Produces: `<PromptCard terminalId={string} />`.

- [ ] **Step 1: Write the component**

```tsx
// packages/web/src/components/tabs/PromptCard.tsx
import { api } from '../../api/client';
import { usePrompts } from '../../stores/prompts';
import { TerminalTab } from './TerminalTab';

/** Surfaces a detected interactive prompt: option buttons, or an inline live
 *  terminal when the prompt couldn't be parsed (never-stuck fallback). */
export function PromptCard({ terminalId }: { terminalId: string }) {
  const prompt = usePrompts((s) => s.byTerminal[terminalId]);
  if (!prompt) return null;

  const clearOptimistic = () => usePrompts.setState((s) => ({ byTerminal: { ...s.byTerminal, [terminalId]: null } }));
  const choose = (keys: string) => { void api.sendInput(terminalId, keys); clearOptimistic(); };
  const openTerminal = () => { /* fallback: just show the inline terminal below */ };

  if (!prompt.parsed) {
    return (
      <div style={{ border: '1px solid var(--color-status-yellow)', borderRadius: 10, overflow: 'hidden', margin: '4px 0' }}>
        <div style={{ padding: '6px 10px', font: '500 12px var(--font-sans)', color: 'var(--color-status-yellow)', background: 'rgba(245,197,66,.08)' }}>
          The agent is asking — answer below
        </div>
        <div style={{ height: 180 }}><TerminalTab terminalId={terminalId} /></div>
      </div>
    );
  }

  return (
    <div style={{ border: '1px solid var(--color-status-yellow)', borderRadius: 10, padding: '10px 12px', margin: '4px 0', background: 'rgba(245,197,66,.06)' }}>
      <div style={{ fontSize: 13, color: 'var(--color-text-primary)', marginBottom: 8 }}>{prompt.question}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {prompt.options.map((o, i) => (
          <button key={i} onClick={() => choose(o.keys)} style={{
            padding: '5px 12px', borderRadius: 7, border: '1px solid #2c2c32', cursor: 'pointer',
            background: i === 0 ? 'var(--color-accent)' : 'var(--color-elevated)',
            color: i === 0 ? '#08240F' : 'var(--color-text-primary)', fontSize: 12.5, fontWeight: 500,
          }}>{o.label}</button>
        ))}
        <button onClick={openTerminal} title="Switch to Terminal mode to answer manually" style={{
          marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--color-text-tertiary)', cursor: 'pointer', fontSize: 11.5,
        }}>Answer in terminal</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount it in ConversationView**

In `packages/web/src/components/tabs/ConversationView.tsx`: add `import { PromptCard } from './PromptCard';` at the top. Then render `<PromptCard terminalId={terminalId} />` inside the composer block, immediately before the queued-messages `{queued.length > 0 && ...}` line (so it sits just above the input). Use the existing `maxWidth: 760` wrapper styling by placing it within the same centered column.

- [ ] **Step 3: Typecheck + build the web**

Run: `cd packages/web && npx tsc -b && npx vite build`
Expected: clean typecheck, successful build.

- [ ] **Step 4: Run the web suite**

Run: `cd packages/web && npx vitest run`
Expected: PASS (all suites green).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/tabs/PromptCard.tsx packages/web/src/components/tabs/ConversationView.tsx
git commit -m "feat(web): PromptCard (option buttons + inline-terminal fallback) in Visual mode"
```

---

## Task 9: Rename "Pretty" → "Visual"

**Files:**
- Modify: `packages/web/src/components/tabs/TabHost.tsx`
- Modify: `packages/web/src/components/tabs/ConversationView.tsx`

**Interfaces:** none (display-only).

- [ ] **Step 1: Update the toggle label**

In `TabHost.tsx`, change the toggle tuple from `[['normal', 'Pretty'], ['expert', 'Terminal']]` to `[['normal', 'Visual'], ['expert', 'Terminal']]`, and update the `/** ... Pretty (conversation) ... */` comment to say `Visual (conversation)`.

- [ ] **Step 2: Update the empty-state copy**

In `ConversationView.tsx`, change `Pretty view isn't available for this thread yet.` to `Visual view isn't available for this thread yet.` and the doc-comment `Pretty mode:` to `Visual mode:`.

- [ ] **Step 3: Verify no stale "Pretty" remains**

Run: `cd packages/web && grep -rn "Pretty" src || echo "none"`
Expected: `none`.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/tabs/TabHost.tsx packages/web/src/components/tabs/ConversationView.tsx
git commit -m "feat(web): rename thread mode Pretty -> Visual"
```

---

## Task 10: Full build, test, deploy

**Files:** none (verification + deploy).

- [ ] **Step 1: Full workspace test + build**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm -r run test && pnpm -r run build`
Expected: all tests pass; all packages build.

- [ ] **Step 2: Boot smoke (isolated)**

Run:
```bash
SMOKE_HOME=$(mktemp -d); PORT=39931 HOME="$SMOKE_HOME" node packages/core/dist/server.js > /tmp/prompt-smoke.log 2>&1 &
P=$!; for i in $(seq 1 40); do grep -q "listening on port" /tmp/prompt-smoke.log && break; sleep 0.25; done
curl -s -o /dev/null -w "sessions:%{http_code}\n" http://127.0.0.1:39931/api/sessions
kill $P; rm -rf "$SMOKE_HOME" /tmp/prompt-smoke.log
```
Expected: `sessions:200`, clean startup log.

- [ ] **Step 3: Push**

```bash
git push origin main
```

- [ ] **Step 4: Deploy + verify mini**

```bash
ssh mini 'zsh -ilc "cd ~/Sites/dispatch && ./bin/dispatch update"'
ssh mini 'zsh -ilc "curl -s -o /dev/null -w \"sessions:%{http_code}\n\" http://localhost:3456/api/sessions"'
```
Expected: build complete, restarted, `sessions:200`.

- [ ] **Step 5: Manual verification on the mini (or MacBook web)**

Open a Claude thread in a fresh/untrusted dir; in Visual mode confirm the trust-folder prompt appears as a card with Yes/No, and tapping it advances the thread. Trigger a model multiple-choice question; confirm a select card appears and answering advances. Confirm an unparsed prompt falls back to an inline terminal.

- [ ] **Step 6: Deploy MacBook last (ends session)**

Confirm with the user first (this restart kills the session). Then:
```bash
cd /Users/davidwebber/Sites/dispatch && ./bin/dispatch restart
```

---

## Self-review notes

- **Spec coverage:** detection pipeline (Tasks 2–6), Claude parsers (3), Codex parsers (4), normalized model (3/7), web card + fallback (8), rename (9), edge cases — dedupe/clear (5), exit-clear (6), multi-step (natural via dedupe+swap), testing (every task), deploy (10). All spec sections mapped.
- **Fixture dependency:** Tasks 3–4 parser literals/keys are validated against Task 1 captures; the plan flags exactly where to adjust if real bytes differ — inherent to TUI parsing, not a placeholder.
- **Type consistency:** `DetectedPrompt`/`PromptOption` identical in core (`prompt.ts`) and web (`prompts.ts`); `terminal:prompt` event shape `{ type, terminalId, prompt }` consistent across PromptService, store, and tests.
- **Store name:** `usePrompts`, consistent across store (`prompts.ts`), tests, and consumers (`App.tsx`, `PromptCard.tsx`).
