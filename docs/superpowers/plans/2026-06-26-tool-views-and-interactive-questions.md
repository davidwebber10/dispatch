# Rich Tool Views + Interactive AskUserQuestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the conversation View tailored rendering for common tool calls (SQL/MCP queries, file-edit diffs, TodoWrite checklists, Web fetch/search) and make Claude `AskUserQuestion` options clickable so the user can answer the live thread from the View.

**Architecture:** All changes are in `packages/web` (no core changes, no daemon restart). A small renderer registry maps a tool name/input-shape to an optional rich renderer; `ToolCall` consults it and falls back to today's generic Input/Output panel for any unmatched tool. `AskUserQuestion` is special-cased directly in the `ConversationView` render loop (it needs live context: the thread id, provider, and whether it's the last/unanswered item) and answers the PTY by sending synthesized keystrokes through the existing `POST /api/terminals/:id/input` route.

**Tech Stack:** React + TypeScript (Vite), Zustand stores, Vitest + @testing-library/react (jsdom). Existing helpers reused: `highlightCode`, `langFromPath`, `renderMarkdown` from `packages/web/src/lib/markdown.ts`; `api.sendInput` from `packages/web/src/api/client.ts`.

## Global Constraints

- **Web-only.** Touch nothing under `packages/core`. No new npm dependencies.
- **Fallback-safe.** Any tool without a custom renderer keeps the current generic Input/Output panel. A renderer that hits malformed input/result must degrade to the generic/raw display, never throw — one bad item must not break the conversation render.
- **Claude-only interactivity.** `AskUserQuestion` answering is enabled only when `tab.type === 'claude-code'`. Codex (`tab.type === 'codex'`) and answered/scrollback questions render read-only.
- **Answerable rule (exact):** an `AskUserQuestion` is answerable iff it has no following `tool-result` AND it is the last item in the items array AND the thread is Claude. Otherwise read-only.
- **Keystroke scheme (exact, arrow+enter):** per question, move the highlight down from option 0 with `DOWN = "\x1b[B"`, toggle a multi-select option with `SPACE = " "`, confirm/advance with `ENTER = "\r"`. The highlight is assumed to reset to the first option for each question; questions are answered in array order. This scheme lives **only** inside `buildAnswerInput`; the live manual test (final step) is the acceptance gate, and if the real TUI needs a different scheme it is changed in that one function.
- **Styling convention:** inline `style={{…}}` objects with `var(--color-…)` tokens, matching `ConversationView.tsx`.
- **Test pattern:** `import { render, screen } from '@testing-library/react'`, `import { vi, test, expect } from 'vitest'`, mock the client with `vi.spyOn(api, 'method')`.

---

### Task 1: Query result table parser (pure)

**Files:**
- Create: `packages/web/src/components/tabs/toolviews/tableParse.ts`
- Test: `packages/web/src/components/tabs/toolviews/tableParse.test.ts`

**Interfaces:**
- Produces: `interface ParsedTable { columns: string[]; rows: string[][] }` and `function parseTable(text: string): ParsedTable | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// tableParse.test.ts
import { test, expect } from 'vitest';
import { parseTable } from './tableParse';

test('parses a JSON array of objects, unioning keys in first-seen order', () => {
  const t = parseTable('[{"id":1,"name":"a"},{"id":2,"name":"b","extra":true}]');
  expect(t).toEqual({
    columns: ['id', 'name', 'extra'],
    rows: [['1', 'a', ''], ['2', 'b', 'true']],
  });
});

test('parses a GitHub-style markdown table', () => {
  const t = parseTable('| id | name |\n| --- | --- |\n| 1 | a |\n| 2 | b |');
  expect(t).toEqual({ columns: ['id', 'name'], rows: [['1', 'a'], ['2', 'b']] });
});

test('parses TSV with a header row', () => {
  const t = parseTable('id\tname\n1\ta\n2\tb');
  expect(t).toEqual({ columns: ['id', 'name'], rows: [['1', 'a'], ['2', 'b']] });
});

test('returns null for non-tabular text', () => {
  expect(parseTable('just some prose output')).toBeNull();
  expect(parseTable('')).toBeNull();
});

test('stringifies nested object cells instead of [object Object]', () => {
  const t = parseTable('[{"a":{"x":1}}]');
  expect(t!.rows[0][0]).toBe('{"x":1}');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-web exec vitest run src/components/tabs/toolviews/tableParse.test.ts`
Expected: FAIL — `parseTable` is not defined / module not found.

- [ ] **Step 3: Implement `tableParse.ts`**

```ts
export interface ParsedTable { columns: string[]; rows: string[][]; }

function fmt(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

function parseMarkdownTable(t: string): ParsedTable | null {
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  if (!lines[0].includes('|')) return null;
  // separator row: only spaces, colons, pipes, dashes — and at least one dash
  if (!/^[\s:|-]+$/.test(lines[1]) || !lines[1].includes('-')) return null;
  const cells = (l: string) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  return { columns: cells(lines[0]), rows: lines.slice(2).map(cells) };
}

export function parseTable(text: string): ParsedTable | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  // 1) JSON array of flat-ish objects
  if (t[0] === '[') {
    try {
      const v = JSON.parse(t);
      if (Array.isArray(v) && v.length && v.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
        const cols: string[] = [];
        for (const row of v) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
        return { columns: cols, rows: v.map((row) => cols.map((c) => fmt((row as Record<string, unknown>)[c]))) };
      }
    } catch { /* fall through */ }
  }
  // 2) markdown table
  const md = parseMarkdownTable(t);
  if (md) return md;
  // 3) TSV
  if (t.includes('\t')) {
    const lines = t.split('\n').filter((l) => l.length);
    if (lines.length >= 2) return { columns: lines[0].split('\t'), rows: lines.slice(1).map((l) => l.split('\t')) };
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-web exec vitest run src/components/tabs/toolviews/tableParse.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/davidwebber/Sites/dispatch
git add packages/web/src/components/tabs/toolviews/tableParse.ts packages/web/src/components/tabs/toolviews/tableParse.test.ts
git commit -m "feat(web): query result table parser (JSON/markdown/TSV)"
```

---

### Task 2: Line diff (pure)

**Files:**
- Create: `packages/web/src/components/tabs/toolviews/diff.ts`
- Test: `packages/web/src/components/tabs/toolviews/diff.test.ts`

**Interfaces:**
- Produces: `type DiffLine = { type: 'add' | 'del' | 'ctx'; text: string }` and `function lineDiff(oldStr: string, newStr: string): DiffLine[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// diff.test.ts
import { test, expect } from 'vitest';
import { lineDiff } from './diff';

test('marks added, removed, and context lines via LCS', () => {
  const d = lineDiff('a\nb\nc', 'a\nB\nc');
  expect(d).toEqual([
    { type: 'ctx', text: 'a' },
    { type: 'del', text: 'b' },
    { type: 'add', text: 'B' },
    { type: 'ctx', text: 'c' },
  ]);
});

test('pure addition at the end', () => {
  expect(lineDiff('a', 'a\nb')).toEqual([
    { type: 'ctx', text: 'a' },
    { type: 'add', text: 'b' },
  ]);
});

test('pure deletion', () => {
  expect(lineDiff('a\nb', 'a')).toEqual([
    { type: 'ctx', text: 'a' },
    { type: 'del', text: 'b' },
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-web exec vitest run src/components/tabs/toolviews/diff.test.ts`
Expected: FAIL — `lineDiff` is not defined.

- [ ] **Step 3: Implement `diff.ts`**

```ts
export type DiffLine = { type: 'add' | 'del' | 'ctx'; text: string };

export function lineDiff(oldStr: string, newStr: string): DiffLine[] {
  const a = oldStr.split('\n');
  const b = newStr.split('\n');
  const n = a.length, m = b.length;
  // dp[i][j] = LCS length of a[i:], b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
    else { out.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-web exec vitest run src/components/tabs/toolviews/diff.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/davidwebber/Sites/dispatch
git add packages/web/src/components/tabs/toolviews/diff.ts packages/web/src/components/tabs/toolviews/diff.test.ts
git commit -m "feat(web): LCS line diff for file-edit rendering"
```

---

### Task 3: AskUserQuestion keystroke encoder (pure)

**Files:**
- Create: `packages/web/src/components/tabs/toolviews/answerInput.ts`
- Test: `packages/web/src/components/tabs/toolviews/answerInput.test.ts`

**Interfaces:**
- Produces:
  - `interface AskOption { label: string; description?: string; preview?: string }`
  - `interface AskQuestion { question: string; header?: string; multiSelect?: boolean; options: AskOption[] }`
  - `function buildAnswerInput(questions: AskQuestion[], selections: number[][]): string` — `selections[i]` is the chosen option indices for question `i` (single-select uses a one-element array).
  - `function parseQuestions(toolInput: string | undefined): AskQuestion[]` — safe parse of the `AskUserQuestion` tool input's `questions` array; returns `[]` on any failure.

- [ ] **Step 1: Write the failing tests**

```ts
// answerInput.test.ts
import { test, expect } from 'vitest';
import { buildAnswerInput, parseQuestions } from './answerInput';

const DOWN = '\x1b[B', ENTER = '\r', SPACE = ' ';

test('single-select first option is just Enter', () => {
  const q = [{ question: 'q', options: [{ label: 'a' }, { label: 'b' }] }];
  expect(buildAnswerInput(q, [[0]])).toBe(ENTER);
});

test('single-select third option moves down twice then Enter', () => {
  const q = [{ question: 'q', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }];
  expect(buildAnswerInput(q, [[2]])).toBe(DOWN + DOWN + ENTER);
});

test('two questions answer in order', () => {
  const q = [
    { question: 'q1', options: [{ label: 'a' }, { label: 'b' }] },
    { question: 'q2', options: [{ label: 'c' }, { label: 'd' }] },
  ];
  expect(buildAnswerInput(q, [[1], [0]])).toBe(DOWN + ENTER + ENTER);
});

test('multiSelect toggles selected options with Space while walking down', () => {
  const q = [{ question: 'q', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }];
  // select indices 0 and 2: SPACE, DOWN, DOWN, SPACE, ENTER
  expect(buildAnswerInput(q, [[0, 2]])).toBe(SPACE + DOWN + DOWN + SPACE + ENTER);
});

test('multiSelect single middle option', () => {
  const q = [{ question: 'q', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] }];
  expect(buildAnswerInput(q, [[1]])).toBe(DOWN + SPACE + ENTER);
});

test('parseQuestions reads the questions array, tolerating junk', () => {
  const input = JSON.stringify({ questions: [{ question: 'q', header: 'H', multiSelect: false, options: [{ label: 'a', description: 'd' }] }] });
  expect(parseQuestions(input)).toEqual([{ question: 'q', header: 'H', multiSelect: false, options: [{ label: 'a', description: 'd' }] }]);
  expect(parseQuestions('not json')).toEqual([]);
  expect(parseQuestions(undefined)).toEqual([]);
  expect(parseQuestions('{"questions":"nope"}')).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-web exec vitest run src/components/tabs/toolviews/answerInput.test.ts`
Expected: FAIL — `buildAnswerInput` / `parseQuestions` not defined.

- [ ] **Step 3: Implement `answerInput.ts`**

```ts
export interface AskOption { label: string; description?: string; preview?: string; }
export interface AskQuestion { question: string; header?: string; multiSelect?: boolean; options: AskOption[]; }

const DOWN = '\x1b[B';
const ENTER = '\r';
const SPACE = ' ';

export function buildAnswerInput(questions: AskQuestion[], selections: number[][]): string {
  let out = '';
  questions.forEach((q, qi) => {
    const sel = (selections[qi] ?? []).slice().sort((a, b) => a - b);
    if (q.multiSelect) {
      const max = sel.length ? sel[sel.length - 1] : -1;
      for (let idx = 0; idx <= max; idx++) {
        if (idx > 0) out += DOWN;
        if (sel.includes(idx)) out += SPACE;
      }
      out += ENTER;
    } else {
      const idx = sel.length ? sel[0] : 0;
      out += DOWN.repeat(idx) + ENTER;
    }
  });
  return out;
}

export function parseQuestions(toolInput: string | undefined): AskQuestion[] {
  if (!toolInput) return [];
  try {
    const v = JSON.parse(toolInput);
    const qs = v?.questions;
    if (!Array.isArray(qs)) return [];
    return qs
      .filter((q) => q && typeof q.question === 'string' && Array.isArray(q.options))
      .map((q) => ({
        question: String(q.question),
        header: typeof q.header === 'string' ? q.header : undefined,
        multiSelect: q.multiSelect === true,
        options: q.options
          .filter((o: unknown) => o && typeof (o as AskOption).label === 'string')
          .map((o: AskOption) => ({ label: String(o.label), description: o.description, preview: o.preview })),
      }));
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-web exec vitest run src/components/tabs/toolviews/answerInput.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/davidwebber/Sites/dispatch
git add packages/web/src/components/tabs/toolviews/answerInput.ts packages/web/src/components/tabs/toolviews/answerInput.test.ts
git commit -m "feat(web): AskUserQuestion keystroke encoder + question parser"
```

---

### Task 4: Extract ToolCall/ToolResult/TabButton into their own file (no behavior change)

This makes the tool-rendering components independently testable and shrinks `ConversationView.tsx` before we layer richness onto them. Pure move — no logic changes.

**Files:**
- Create: `packages/web/src/components/tabs/ToolCall.tsx`
- Modify: `packages/web/src/components/tabs/ConversationView.tsx` (remove the three component definitions; import them; the `Item` function's `tool-result` branch keeps working via the imported `ToolResult`)
- Test: `packages/web/src/components/tabs/ToolCall.test.tsx`

**Interfaces:**
- Produces: `export function ToolCall({ tool, result, onViewFile }: { tool: ConvItem; result?: ConvItem; onViewFile?: (path: string) => void })` and `export function ToolResult({ item }: { item: ConvItem })`. (`TabButton` is internal to `ToolCall.tsx`.)
- Consumes: `highlightCode`, `langFromPath` from `../../lib/markdown`; `ConvItem` from `../../api/types`; phosphor icons `CaretRight`, `Wrench`, `FileText`.

- [ ] **Step 1: Create `ToolCall.tsx` by moving the existing code verbatim**

Move the current `ToolCall` (lines ~491–540), `TabButton` (542–549), and `ToolResult` (551–573) out of `ConversationView.tsx` into a new file. Add imports at the top and `export` on `ToolCall` and `ToolResult`. The moved bodies are unchanged:

```tsx
// packages/web/src/components/tabs/ToolCall.tsx
import { useState } from 'react';
import { CaretRight, Wrench, FileText } from '@phosphor-icons/react';
import type { ConvItem } from '../../api/types';
import { highlightCode, langFromPath } from '../../lib/markdown';

/** A tool call: single-line summary; expand to an Input/Output tabbed, syntax-
 *  highlighted shelf. If it references a file, the shelf offers "View file". */
export function ToolCall({ tool, result, onViewFile }: { tool: ConvItem; result?: ConvItem; onViewFile?: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'input' | 'output'>('output');
  const name = tool.toolTitle ?? tool.toolName ?? 'Tool';
  const input = tool.toolInput ?? '';
  const out = result?.text ?? '';
  const hasIn = !!input.trim();
  const hasOut = !!out.trim();
  const err = result?.isError;
  const lines = hasOut ? out.split('\n').length : 0;
  const expandable = hasIn || hasOut;
  const effTab: 'input' | 'output' = (tab === 'input' && hasIn) ? 'input' : (hasOut ? 'output' : 'input');
  const content = effTab === 'input' ? input : out;
  const lang = effTab === 'input' ? (tool.toolName === 'Bash' ? 'bash' : 'json') : langFromPath(tool.toolFile);
  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 9, background: 'var(--color-elevated)', overflow: 'hidden' }}>
      <button
        onClick={() => expandable && setOpen((o) => !o)}
        style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: expandable ? 'pointer' : 'default', padding: '8px 10px', display: 'flex', gap: 8, alignItems: 'center' }}
      >
        <CaretRight size={11} weight="bold" style={{ flexShrink: 0, color: 'var(--color-text-tertiary)', visibility: expandable ? 'visible' : 'hidden', transition: 'transform .12s ease', transform: open ? 'rotate(90deg)' : 'none' }} />
        <Wrench size={13} color="#5A8DD6" style={{ flexShrink: 0 }} />
        <span style={{ minWidth: 0, flex: 1, fontSize: 12.5, color: 'var(--color-text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        {result && <span style={{ flexShrink: 0, fontSize: 11, color: err ? 'var(--color-status-red)' : 'var(--color-text-tertiary)' }}>{err ? 'error' : `${lines} line${lines !== 1 ? 's' : ''}`}</span>}
      </button>
      {open && expandable && (
        <div style={{ borderTop: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '6px 8px 0', background: 'var(--color-pane)' }}>
            {hasIn && <TabButton active={effTab === 'input'} onClick={() => setTab('input')}>Input</TabButton>}
            {hasOut && <TabButton active={effTab === 'output'} onClick={() => setTab('output')}>Output</TabButton>}
            {tool.toolFile && onViewFile && (
              <button
                onClick={() => onViewFile(tool.toolFile!)}
                title={tool.toolFile}
                style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', color: 'var(--color-accent)', font: '500 11.5px var(--font-sans)', cursor: 'pointer', padding: '3px 4px' }}
              >
                <FileText size={13} weight="bold" /> View file
              </button>
            )}
          </div>
          <pre className="hljs" style={{ margin: 0, font: '400 11.5px var(--font-mono)', lineHeight: 1.5, padding: '9px 11px', maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            <code dangerouslySetInnerHTML={{ __html: highlightCode(content, lang) }} />
          </pre>
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 11px', fontSize: 11.5, borderRadius: '6px 6px 0 0', border: 'none', cursor: 'pointer',
      background: active ? 'var(--color-elevated)' : 'transparent', color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', fontWeight: active ? 600 : 400,
    }}>{children}</button>
  );
}

/** A tool result, minimized to a one-line summary and expandable on click. */
export function ToolResult({ item }: { item: ConvItem }) {
  const [open, setOpen] = useState(false);
  const text = item.text ?? '';
  if (!text.trim()) return null;
  const lines = text.split('\n').length;
  const err = item.isError;
  const color = err ? 'var(--color-status-red)' : 'var(--color-text-tertiary)';
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', padding: '1px 0', font: '400 11.5px var(--font-mono)', color }}
      >
        <CaretRight size={10} weight="bold" style={{ transition: 'transform .12s ease', transform: open ? 'rotate(90deg)' : 'none' }} />
        {err ? 'Error output' : 'Output'}<span style={{ opacity: 0.6 }}> · {lines} line{lines !== 1 ? 's' : ''}</span>
      </button>
      {open && (
        <pre style={{ margin: '4px 0 0', font: '400 11.5px var(--font-mono)', lineHeight: 1.5, color, background: 'var(--color-elevated)', border: `1px solid ${err ? 'rgba(240,97,109,.3)' : 'var(--color-border)'}`, borderRadius: 8, padding: '8px 10px', maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</pre>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update `ConversationView.tsx`**

Delete the moved `ToolCall`, `TabButton`, and `ToolResult` function definitions. Add to the import block near the top (after the `markdown` import on line 12):

```tsx
import { ToolCall, ToolResult } from './ToolCall';
```

Remove the now-unused `FileText` from the phosphor import on line 2 (it is only used by `ToolCall`) and keep `Wrench`/`CaretRight` (still used by the inline `Item` tool branch / search). Verify `Wrench` and `CaretRight` are still referenced in `ConversationView.tsx`; if `CaretRight` is no longer used there, remove it from the import too.

- [ ] **Step 3: Write the regression test**

```tsx
// ToolCall.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { test, expect } from 'vitest';
import { ToolCall } from './ToolCall';

test('renders a generic tool with expandable Input/Output for an unmatched tool', () => {
  const tool = { kind: 'tool', toolName: 'Bash', toolTitle: 'Bash', toolInput: 'ls -la' } as any;
  const result = { kind: 'tool-result', text: 'file1\nfile2' } as any;
  render(<ToolCall tool={tool} result={result} />);
  expect(screen.getByText('Bash')).toBeInTheDocument();
  expect(screen.getByText('2 lines')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Bash'));
  expect(screen.getByText('Output')).toBeInTheDocument();
});
```

- [ ] **Step 4: Run the test + full web suite + typecheck**

Run:
```
cd /Users/davidwebber/Sites/dispatch
pnpm --filter dispatch-web exec vitest run src/components/tabs/ToolCall.test.tsx
pnpm --filter dispatch-web exec tsc --noEmit
```
Expected: test PASS; tsc clean (no unused-import errors from the edit).

- [ ] **Step 5: Commit**

```bash
cd /Users/davidwebber/Sites/dispatch
git add packages/web/src/components/tabs/ToolCall.tsx packages/web/src/components/tabs/ToolCall.test.tsx packages/web/src/components/tabs/ConversationView.tsx
git commit -m "refactor(web): extract ToolCall/ToolResult into their own file"
```

---

### Task 5: Renderer registry + QueryView, wired into ToolCall

**Files:**
- Create: `packages/web/src/components/tabs/toolviews/registry.tsx`
- Create: `packages/web/src/components/tabs/toolviews/QueryView.tsx`
- Modify: `packages/web/src/components/tabs/ToolCall.tsx` (consult the registry)
- Test: `packages/web/src/components/tabs/toolviews/QueryView.test.tsx`

**Interfaces:**
- Produces:
  - `interface ToolView { icon?: React.ReactNode; label?: (tool: ConvItem) => string; expanded: (tool: ConvItem, result: ConvItem | undefined) => React.ReactNode }`
  - `function parseToolInput(toolInput: string | undefined): any` (safe JSON parse → object or `null`)
  - `function getToolView(toolName: string | undefined, input: any): ToolView | null`
  - `function QueryView({ tool, result }: { tool: ConvItem; result?: ConvItem })`
- Consumes: `parseTable` (Task 1), `highlightCode` from `../../../lib/markdown`.

- [ ] **Step 1: Write the failing tests**

```tsx
// QueryView.test.tsx
import { render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';
import { getToolView, parseToolInput } from './registry';
import { QueryView } from './QueryView';

test('getToolView matches a tool whose input has a sql/query/statement field', () => {
  expect(getToolView('mcp__databricks__databricks_query', { query: 'SELECT 1' })).not.toBeNull();
  expect(getToolView('run_shopifyql_query', { query: 'FROM sales SHOW x' })).not.toBeNull();
  expect(getToolView('SomeTool', { statement: 'SELECT 2' })).not.toBeNull();
});

test('getToolView returns null when there is no query field and no other match', () => {
  expect(getToolView('mcp__acumatica__acumatica_search_orders', { filter: 'x' })).toBeNull();
});

test('parseToolInput safely returns null on junk', () => {
  expect(parseToolInput('not json')).toBeNull();
  expect(parseToolInput(undefined)).toBeNull();
});

test('QueryView renders the SQL and a result table', () => {
  const tool = { kind: 'tool', toolName: 'mcp__databricks__databricks_query', toolInput: JSON.stringify({ query: 'SELECT id, name FROM t' }) } as any;
  const result = { kind: 'tool-result', text: '[{"id":1,"name":"a"}]' } as any;
  render(<QueryView tool={tool} result={result} />);
  expect(screen.getByText(/SELECT id, name FROM t/)).toBeInTheDocument();
  expect(screen.getByText('name')).toBeInTheDocument(); // a column header
  expect(screen.getByText('a')).toBeInTheDocument();    // a cell
});

test('QueryView falls back to raw result text when not tabular', () => {
  const tool = { kind: 'tool', toolName: 'x', toolInput: JSON.stringify({ query: 'SELECT 1' }) } as any;
  const result = { kind: 'tool-result', text: 'Query returned no rows.' } as any;
  render(<QueryView tool={tool} result={result} />);
  expect(screen.getByText('Query returned no rows.')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-web exec vitest run src/components/tabs/toolviews/QueryView.test.tsx`
Expected: FAIL — modules not defined.

- [ ] **Step 3: Implement `QueryView.tsx`**

```tsx
import type { ConvItem } from '../../../api/types';
import { highlightCode } from '../../../lib/markdown';
import { parseTable } from './tableParse';

const MAX_ROWS = 200;

function queryText(tool: ConvItem): string {
  try {
    const v = JSON.parse(tool.toolInput ?? '{}');
    return String(v.query ?? v.sql ?? v.statement ?? '');
  } catch { return ''; }
}

export function QueryView({ tool, result }: { tool: ConvItem; result?: ConvItem }) {
  const sql = queryText(tool);
  const out = result?.text ?? '';
  const table = out.trim() ? parseTable(out) : null;
  return (
    <div>
      {sql && (
        <pre className="hljs" style={{ margin: 0, font: '400 11.5px var(--font-mono)', lineHeight: 1.5, padding: '9px 11px', borderBottom: out ? '1px solid var(--color-border)' : 'none', maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          <code dangerouslySetInnerHTML={{ __html: highlightCode(sql, 'sql') }} />
        </pre>
      )}
      {result && (table
        ? <ResultTable columns={table.columns} rows={table.rows} />
        : (out.trim()
          ? <pre style={{ margin: 0, font: '400 11.5px var(--font-mono)', lineHeight: 1.5, padding: '9px 11px', maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: result.isError ? 'var(--color-status-red)' : 'var(--color-text-secondary)' }}>{out}</pre>
          : null))}
    </div>
  );
}

function ResultTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  const shown = rows.slice(0, MAX_ROWS);
  const th: React.CSSProperties = { textAlign: 'left', padding: '5px 9px', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', fontWeight: 600, position: 'sticky', top: 0, background: 'var(--color-pane)', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '4px 9px', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-primary)', whiteSpace: 'nowrap', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' };
  return (
    <div style={{ maxHeight: 320, overflow: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', font: '400 11.5px var(--font-mono)', minWidth: '100%' }}>
        <thead><tr>{columns.map((c, i) => <th key={i} style={th}>{c}</th>)}</tr></thead>
        <tbody>{shown.map((r, ri) => <tr key={ri}>{columns.map((_, ci) => <td key={ci} style={td} title={r[ci] ?? ''}>{r[ci] ?? ''}</td>)}</tr>)}</tbody>
      </table>
      {rows.length > MAX_ROWS && <div style={{ padding: '6px 9px', color: 'var(--color-text-tertiary)', fontSize: 11 }}>+{rows.length - MAX_ROWS} more rows</div>}
    </div>
  );
}
```

- [ ] **Step 4: Implement `registry.tsx`**

```tsx
import type { ConvItem } from '../../../api/types';
import { Database, Wrench } from '@phosphor-icons/react';
import { QueryView } from './QueryView';

export interface ToolView {
  icon?: React.ReactNode;
  label?: (tool: ConvItem) => string;
  expanded: (tool: ConvItem, result: ConvItem | undefined) => React.ReactNode;
}

export function parseToolInput(toolInput: string | undefined): any {
  if (!toolInput) return null;
  try { const v = JSON.parse(toolInput); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

function hasQuery(input: any): boolean {
  return !!input && (typeof input.query === 'string' || typeof input.sql === 'string' || typeof input.statement === 'string');
}

export function getToolView(toolName: string | undefined, input: any): ToolView | null {
  if (hasQuery(input)) {
    return {
      icon: <Database size={13} color="#5A8DD6" style={{ flexShrink: 0 }} />,
      label: (t) => t.toolTitle ?? t.toolName ?? 'Query',
      expanded: (t, r) => <QueryView tool={t} result={r} />,
    };
  }
  return null;
}

// Silences an unused import until later tasks add views that use Wrench, if any.
void Wrench;
```

Note: remove the `void Wrench;` line and the `Wrench` import if you do not reference it — keep the import list minimal so `tsc` stays clean. (It is included only as a convenience anchor; later tasks may add icons here.)

- [ ] **Step 5: Wire the registry into `ToolCall.tsx`**

In `ToolCall.tsx`, add imports and consult the registry. Replace the body so a matched view renders its rich `expanded` (and optional icon/label) while everything else keeps the existing generic panel:

```tsx
import { getToolView, parseToolInput } from './toolviews/registry';
// ...inside ToolCall, after computing name/input/out/etc:
const view = getToolView(tool.toolName, parseToolInput(tool.toolInput));
const headerIcon = view?.icon ?? <Wrench size={13} color="#5A8DD6" style={{ flexShrink: 0 }} />;
const headerName = view?.label?.(tool) ?? name;
const expandable = view ? (!!input.trim() || !!out.trim()) : (hasIn || hasOut);
```

In the header JSX, replace the `<Wrench .../>` with `{headerIcon}` and `{name}` with `{headerName}`. In the expanded region, branch:

```tsx
{open && expandable && (
  <div style={{ borderTop: '1px solid var(--color-border)' }}>
    {view
      ? view.expanded(tool, result)
      : (/* existing tabs + <pre> block, unchanged */)}
  </div>
)}
```

Keep the existing tabs/`<pre>` block verbatim as the `else` branch.

- [ ] **Step 6: Run the tests + typecheck**

Run:
```
cd /Users/davidwebber/Sites/dispatch
pnpm --filter dispatch-web exec vitest run src/components/tabs/toolviews/QueryView.test.tsx src/components/tabs/ToolCall.test.tsx
pnpm --filter dispatch-web exec tsc --noEmit
```
Expected: all PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/davidwebber/Sites/dispatch
git add packages/web/src/components/tabs/toolviews/registry.tsx packages/web/src/components/tabs/toolviews/QueryView.tsx packages/web/src/components/tabs/ToolCall.tsx
git commit -m "feat(web): tool-view registry + rich SQL query/result rendering"
```

---

### Task 6: DiffView (Edit / MultiEdit / Write)

**Files:**
- Create: `packages/web/src/components/tabs/toolviews/DiffView.tsx`
- Modify: `packages/web/src/components/tabs/toolviews/registry.tsx` (add the branch)
- Test: `packages/web/src/components/tabs/toolviews/DiffView.test.tsx`

**Interfaces:**
- Consumes: `lineDiff`, `DiffLine` (Task 2); `highlightCode`, `langFromPath` from `../../../lib/markdown`.
- Produces: `function DiffView({ tool }: { tool: ConvItem })`.

- [ ] **Step 1: Write the failing tests**

```tsx
// DiffView.test.tsx
import { render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';
import { getToolView } from './registry';
import { DiffView } from './DiffView';

test('getToolView matches Edit, MultiEdit, Write', () => {
  expect(getToolView('Edit', { old_string: 'a', new_string: 'b' })).not.toBeNull();
  expect(getToolView('MultiEdit', { edits: [] })).not.toBeNull();
  expect(getToolView('Write', { content: 'x' })).not.toBeNull();
});

test('DiffView shows removed and added lines for an Edit', () => {
  const tool = { kind: 'tool', toolName: 'Edit', toolFile: 'a.ts', toolInput: JSON.stringify({ old_string: 'const a = 1', new_string: 'const a = 2' }) } as any;
  render(<DiffView tool={tool} />);
  expect(screen.getByText('const a = 1')).toBeInTheDocument();
  expect(screen.getByText('const a = 2')).toBeInTheDocument();
});

test('DiffView shows file content for a Write', () => {
  const tool = { kind: 'tool', toolName: 'Write', toolFile: 'a.ts', toolInput: JSON.stringify({ content: 'hello world' }) } as any;
  render(<DiffView tool={tool} />);
  expect(screen.getByText(/hello world/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-web exec vitest run src/components/tabs/toolviews/DiffView.test.tsx`
Expected: FAIL — `DiffView` not defined; the `getToolView` cases for Edit/MultiEdit/Write return null.

- [ ] **Step 3: Implement `DiffView.tsx`**

```tsx
import type { ConvItem } from '../../../api/types';
import { highlightCode, langFromPath } from '../../../lib/markdown';
import { lineDiff, type DiffLine } from './diff';

function Hunk({ lines }: { lines: DiffLine[] }) {
  const bg = (t: DiffLine['type']) => t === 'add' ? 'rgba(63,185,80,.14)' : t === 'del' ? 'rgba(240,97,109,.14)' : 'transparent';
  const fg = (t: DiffLine['type']) => t === 'add' ? '#5fce7e' : t === 'del' ? '#f0616d' : 'var(--color-text-secondary)';
  const sign = (t: DiffLine['type']) => t === 'add' ? '+' : t === 'del' ? '-' : ' ';
  return (
    <pre style={{ margin: 0, font: '400 11.5px var(--font-mono)', lineHeight: 1.5, overflow: 'auto', maxHeight: 360 }}>
      {lines.map((l, i) => (
        <div key={i} style={{ background: bg(l.type), color: fg(l.type), padding: '0 11px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          <span style={{ opacity: 0.6, userSelect: 'none' }}>{sign(l.type)} </span>{l.text}
        </div>
      ))}
    </pre>
  );
}

export function DiffView({ tool }: { tool: ConvItem }) {
  let input: any = {};
  try { input = JSON.parse(tool.toolInput ?? '{}'); } catch { /* raw fallback below */ }

  if (tool.toolName === 'Write') {
    const content = String(input.content ?? '');
    return (
      <pre className="hljs" style={{ margin: 0, font: '400 11.5px var(--font-mono)', lineHeight: 1.5, padding: '9px 11px', maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        <code dangerouslySetInnerHTML={{ __html: highlightCode(content, langFromPath(tool.toolFile)) }} />
      </pre>
    );
  }

  const edits: Array<{ old_string?: string; new_string?: string }> =
    tool.toolName === 'MultiEdit' && Array.isArray(input.edits) ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];

  return (
    <div>
      {edits.map((e, i) => (
        <div key={i} style={{ borderTop: i > 0 ? '1px solid var(--color-border)' : 'none' }}>
          <Hunk lines={lineDiff(String(e.old_string ?? ''), String(e.new_string ?? ''))} />
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Add the registry branch in `registry.tsx`**

Add an import and a branch (place it before the `hasQuery` check):

```tsx
import { DiffView } from './DiffView';
import { Database, PencilSimple } from '@phosphor-icons/react';
// ...inside getToolView, before the hasQuery branch:
if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write') {
  return {
    icon: <PencilSimple size={13} color="#5A8DD6" style={{ flexShrink: 0 }} />,
    label: (t) => t.toolTitle ?? t.toolName ?? 'Edit',
    expanded: (t) => <DiffView tool={t} />,
  };
}
```

- [ ] **Step 5: Run the tests + typecheck**

Run:
```
cd /Users/davidwebber/Sites/dispatch
pnpm --filter dispatch-web exec vitest run src/components/tabs/toolviews/DiffView.test.tsx
pnpm --filter dispatch-web exec tsc --noEmit
```
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/davidwebber/Sites/dispatch
git add packages/web/src/components/tabs/toolviews/DiffView.tsx packages/web/src/components/tabs/toolviews/DiffView.test.tsx packages/web/src/components/tabs/toolviews/registry.tsx
git commit -m "feat(web): red/green diff rendering for Edit/MultiEdit/Write"
```

---

### Task 7: TodoView (TodoWrite checklist)

**Files:**
- Create: `packages/web/src/components/tabs/toolviews/TodoView.tsx`
- Modify: `packages/web/src/components/tabs/toolviews/registry.tsx`
- Test: `packages/web/src/components/tabs/toolviews/TodoView.test.tsx`

**Interfaces:**
- Consumes: `TodoItem` from `../../../api/types` (`{ content: string; status: string; activeForm?: string }`).
- Produces: `function TodoView({ tool }: { tool: ConvItem })`.

- [ ] **Step 1: Write the failing tests**

```tsx
// TodoView.test.tsx
import { render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';
import { getToolView } from './registry';
import { TodoView } from './TodoView';

test('getToolView matches TodoWrite', () => {
  expect(getToolView('TodoWrite', { todos: [] })).not.toBeNull();
});

test('TodoView renders each todo with a status glyph', () => {
  const tool = { kind: 'tool', toolName: 'TodoWrite', toolInput: JSON.stringify({ todos: [
    { content: 'first', status: 'completed' },
    { content: 'second', status: 'in_progress', activeForm: 'Doing second' },
    { content: 'third', status: 'pending' },
  ] }) } as any;
  render(<TodoView tool={tool} />);
  expect(screen.getByText('first')).toBeInTheDocument();
  expect(screen.getByText('Doing second')).toBeInTheDocument(); // activeForm shown while in progress
  expect(screen.getByText('third')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-web exec vitest run src/components/tabs/toolviews/TodoView.test.tsx`
Expected: FAIL — `TodoView` not defined; `getToolView('TodoWrite', …)` returns null.

- [ ] **Step 3: Implement `TodoView.tsx`**

```tsx
import type { ConvItem, TodoItem } from '../../../api/types';

const GLYPH: Record<string, string> = { completed: '✓', in_progress: '◐', pending: '○' };

export function TodoView({ tool }: { tool: ConvItem }) {
  let todos: TodoItem[] = [];
  try { const v = JSON.parse(tool.toolInput ?? '{}'); if (Array.isArray(v.todos)) todos = v.todos; } catch { /* empty */ }
  if (!todos.length) return <div style={{ padding: '9px 11px', color: 'var(--color-text-tertiary)', fontSize: 12 }}>No items.</div>;
  return (
    <div style={{ padding: '8px 11px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      {todos.map((t, i) => {
        const done = t.status === 'completed';
        const active = t.status === 'in_progress';
        const text = active && t.activeForm ? t.activeForm : t.content;
        return (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5, color: done ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)' }}>
            <span style={{ flexShrink: 0, color: active ? 'var(--color-accent)' : done ? 'var(--color-status-green, #5fce7e)' : 'var(--color-text-tertiary)' }}>{GLYPH[t.status] ?? '○'}</span>
            <span style={{ textDecoration: done ? 'line-through' : 'none', fontWeight: active ? 600 : 400 }}>{text}</span>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Add the registry branch in `registry.tsx`**

```tsx
import { TodoView } from './TodoView';
import { ListChecks } from '@phosphor-icons/react';
// ...inside getToolView, before hasQuery:
if (toolName === 'TodoWrite') {
  return {
    icon: <ListChecks size={13} color="#5A8DD6" style={{ flexShrink: 0 }} />,
    label: () => 'Updated plan',
    expanded: (t) => <TodoView tool={t} />,
  };
}
```

- [ ] **Step 5: Run the tests + typecheck**

Run:
```
cd /Users/davidwebber/Sites/dispatch
pnpm --filter dispatch-web exec vitest run src/components/tabs/toolviews/TodoView.test.tsx
pnpm --filter dispatch-web exec tsc --noEmit
```
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/davidwebber/Sites/dispatch
git add packages/web/src/components/tabs/toolviews/TodoView.tsx packages/web/src/components/tabs/toolviews/TodoView.test.tsx packages/web/src/components/tabs/toolviews/registry.tsx
git commit -m "feat(web): TodoWrite checklist rendering"
```

---

### Task 8: WebView (WebFetch / WebSearch)

**Files:**
- Create: `packages/web/src/components/tabs/toolviews/WebView.tsx`
- Modify: `packages/web/src/components/tabs/toolviews/registry.tsx`
- Test: `packages/web/src/components/tabs/toolviews/WebView.test.tsx`

**Interfaces:**
- Consumes: `renderMarkdown` from `../../../lib/markdown`.
- Produces: `function WebView({ tool, result }: { tool: ConvItem; result?: ConvItem })`.

- [ ] **Step 1: Write the failing tests**

```tsx
// WebView.test.tsx
import { render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';
import { getToolView } from './registry';
import { WebView } from './WebView';

test('getToolView matches WebFetch and WebSearch', () => {
  expect(getToolView('WebFetch', { url: 'https://x.com' })).not.toBeNull();
  expect(getToolView('WebSearch', { query: 'hello' })).not.toBeNull();
});

test('WebView shows the URL and a result snippet for WebFetch', () => {
  const tool = { kind: 'tool', toolName: 'WebFetch', toolInput: JSON.stringify({ url: 'https://example.com/x', prompt: 'summarize' }) } as any;
  const result = { kind: 'tool-result', text: 'A short summary.' } as any;
  render(<WebView tool={tool} result={result} />);
  expect(screen.getByText('https://example.com/x')).toBeInTheDocument();
  expect(screen.getByText(/A short summary\./)).toBeInTheDocument();
});

test('WebView shows the query for WebSearch', () => {
  const tool = { kind: 'tool', toolName: 'WebSearch', toolInput: JSON.stringify({ query: 'best widgets' }) } as any;
  render(<WebView tool={tool} />);
  expect(screen.getByText('best widgets')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-web exec vitest run src/components/tabs/toolviews/WebView.test.tsx`
Expected: FAIL — `WebView` not defined; `getToolView` for WebFetch/WebSearch returns null.

- [ ] **Step 3: Implement `WebView.tsx`**

```tsx
import type { ConvItem } from '../../../api/types';
import { renderMarkdown } from '../../../lib/markdown';

export function WebView({ tool, result }: { tool: ConvItem; result?: ConvItem }) {
  let input: any = {};
  try { input = JSON.parse(tool.toolInput ?? '{}'); } catch { /* empty */ }
  const url = typeof input.url === 'string' ? input.url : '';
  const query = typeof input.query === 'string' ? input.query : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const out = result?.text ?? '';
  return (
    <div style={{ padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {url && <div style={{ font: '500 12px var(--font-mono)', color: 'var(--color-accent)', wordBreak: 'break-all' }}>{url}</div>}
      {query && <div style={{ font: '500 12.5px var(--font-sans)', color: 'var(--color-text-primary)' }}>{query}</div>}
      {prompt && <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{prompt}</div>}
      {out.trim() && <div className="md-view" style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }} dangerouslySetInnerHTML={{ __html: renderMarkdown(out) }} />}
    </div>
  );
}
```

- [ ] **Step 4: Add the registry branch in `registry.tsx`**

```tsx
import { WebView } from './WebView';
import { Globe } from '@phosphor-icons/react';
// ...inside getToolView, before hasQuery (so WebSearch's `query` field doesn't fall into the SQL branch):
if (toolName === 'WebFetch' || toolName === 'WebSearch') {
  return {
    icon: <Globe size={13} color="#5A8DD6" style={{ flexShrink: 0 }} />,
    label: (t) => t.toolTitle ?? t.toolName ?? 'Web',
    expanded: (t, r) => <WebView tool={t} result={r} />,
  };
}
```

NOTE (ordering): the `WebSearch` branch MUST come before the `hasQuery` SQL branch, because `WebSearch` input also has a `query` field. Verify the final `getToolView` order is: Edit/Write → TodoWrite → WebFetch/WebSearch → hasQuery → null.

- [ ] **Step 5: Run the tests + typecheck**

Run:
```
cd /Users/davidwebber/Sites/dispatch
pnpm --filter dispatch-web exec vitest run src/components/tabs/toolviews/WebView.test.tsx src/components/tabs/toolviews/QueryView.test.tsx
pnpm --filter dispatch-web exec tsc --noEmit
```
Expected: PASS (re-running QueryView confirms the ordering didn't break SQL matching); tsc clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/davidwebber/Sites/dispatch
git add packages/web/src/components/tabs/toolviews/WebView.tsx packages/web/src/components/tabs/toolviews/WebView.test.tsx packages/web/src/components/tabs/toolviews/registry.tsx
git commit -m "feat(web): WebFetch/WebSearch rendering"
```

---

### Task 9: AskQuestionView (read-only) + ConversationView wiring

Renders the question(s) and options. Read-only in this task (no submit yet). Wires it into the `ConversationView` render loop with the Claude-only + answerable gating, so a Codex thread or an answered question shows read-only.

**Files:**
- Create: `packages/web/src/components/tabs/toolviews/AskQuestionView.tsx`
- Modify: `packages/web/src/components/tabs/ConversationView.tsx` (render-loop branch)
- Test: `packages/web/src/components/tabs/toolviews/AskQuestionView.test.tsx`

**Interfaces:**
- Consumes: `parseQuestions`, `AskQuestion` (Task 3).
- Produces: `function AskQuestionView(props: { tool: ConvItem; result?: ConvItem; answerable: boolean; terminalId: string; onAnswerInTerminal: () => void })`. In this task it ignores `terminalId`/`onAnswerInTerminal` (used in Task 10) and renders read-only controls regardless; the `answerable` flag only toggles whether buttons are interactive (wired in Task 10). For this task, render the questions and options as non-interactive content.

- [ ] **Step 1: Write the failing tests**

```tsx
// AskQuestionView.test.tsx
import { render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';
import { AskQuestionView } from './AskQuestionView';

const tool = {
  kind: 'tool', toolName: 'AskUserQuestion', uuid: 'u1',
  toolInput: JSON.stringify({ questions: [
    { question: 'Which approach?', header: 'Approach', multiSelect: false, options: [
      { label: 'Option A', description: 'first' }, { label: 'Option B', description: 'second' },
    ] },
  ] }),
} as any;

test('renders the question, header chip, and options', () => {
  render(<AskQuestionView tool={tool} answerable={false} terminalId="t1" onAnswerInTerminal={() => {}} />);
  expect(screen.getByText('Which approach?')).toBeInTheDocument();
  expect(screen.getByText('Approach')).toBeInTheDocument();
  expect(screen.getByText('Option A')).toBeInTheDocument();
  expect(screen.getByText('Option B')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-web exec vitest run src/components/tabs/toolviews/AskQuestionView.test.tsx`
Expected: FAIL — `AskQuestionView` not defined.

- [ ] **Step 3: Implement `AskQuestionView.tsx` (read-only shell; interactivity added in Task 10)**

```tsx
import type { ConvItem } from '../../../api/types';
import { parseQuestions, type AskQuestion } from './answerInput';

export function AskQuestionView({ tool }: {
  tool: ConvItem; result?: ConvItem; answerable: boolean; terminalId: string; onAnswerInTerminal: () => void;
}) {
  const questions = parseQuestions(tool.toolInput);
  if (!questions.length) return null;
  return (
    <div style={{ border: '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)', borderRadius: 10, background: 'color-mix(in srgb, var(--color-accent) 6%, transparent)', overflow: 'hidden' }}>
      {questions.map((q, qi) => <QuestionBlock key={qi} q={q} />)}
    </div>
  );
}

function QuestionBlock({ q }: { q: AskQuestion }) {
  return (
    <div style={{ padding: '11px 13px', borderTop: '1px solid var(--color-border)' }}>
      {q.header && <div style={{ display: 'inline-block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--color-accent)', border: '1px solid color-mix(in srgb, var(--color-accent) 40%, transparent)', borderRadius: 5, padding: '1px 6px', marginBottom: 6 }}>{q.header}</div>}
      <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 8 }}>{q.question}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {q.options.map((o, oi) => (
          <div key={oi} style={{ textAlign: 'left', border: '1px solid var(--color-border)', borderRadius: 8, padding: '8px 10px', background: 'var(--color-elevated)' }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>{o.label}</div>
            {o.description && <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{o.description}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire into `ConversationView.tsx`**

Add the import (with the other tab imports):

```tsx
import { AskQuestionView } from './toolviews/AskQuestionView';
```

In the render loop (currently lines ~335–339), replace the `it.kind === 'tool'` branch with:

```tsx
if (it.kind === 'tool') {
  const next = items[i + 1];
  const result = next?.kind === 'tool-result' ? next : undefined;
  if (it.toolName === 'AskUserQuestion') {
    const answerable = !result && i === items.length - 1 && tab?.type === 'claude-code';
    node = <AskQuestionView tool={it} result={result} answerable={answerable} terminalId={terminalId} onAnswerInTerminal={() => setMode(terminalId, 'expert')} />;
  } else {
    node = <ToolCall tool={it} result={result} onViewFile={openFileInViewer} />;
  }
  if (result) i++;
}
```

(`tab`, `terminalId`, and `setMode` are already in scope in `ConversationView`.)

- [ ] **Step 5: Run the test + full web suite + typecheck**

Run:
```
cd /Users/davidwebber/Sites/dispatch
pnpm --filter dispatch-web exec vitest run src/components/tabs/toolviews/AskQuestionView.test.tsx
pnpm --filter dispatch-web exec tsc --noEmit
```
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/davidwebber/Sites/dispatch
git add packages/web/src/components/tabs/toolviews/AskQuestionView.tsx packages/web/src/components/tabs/toolviews/AskQuestionView.test.tsx packages/web/src/components/tabs/ConversationView.tsx
git commit -m "feat(web): render AskUserQuestion questions/options in View (read-only)"
```

---

### Task 10: AskQuestionView interactive — select, submit, optimistic state, Terminal fallback

Adds selection state and submit. On submit, encode keystrokes via `buildAnswerInput` and `api.sendInput`, record the choice optimistically (so the card reflects it immediately), and if no result lands within 6s expose an "Answer in Terminal →" action.

**Files:**
- Create: `packages/web/src/stores/questionAnswers.ts`
- Modify: `packages/web/src/components/tabs/toolviews/AskQuestionView.tsx`
- Test: `packages/web/src/components/tabs/toolviews/AskQuestionView.test.tsx` (extend)

**Interfaces:**
- Consumes: `buildAnswerInput` (Task 3); `api.sendInput` from `../../../api/client`.
- Produces: `useQuestionAnswers` store: `{ byUuid: Record<string, number[][]>; submit(uuid: string, selections: number[][]): void }`.

- [ ] **Step 1: Implement the optimistic store `questionAnswers.ts`**

```ts
import { create } from 'zustand';

interface QuestionAnswersState {
  byUuid: Record<string, number[][]>;
  submit: (uuid: string, selections: number[][]) => void;
}

export const useQuestionAnswers = create<QuestionAnswersState>((set) => ({
  byUuid: {},
  submit: (uuid, selections) => set((s) => ({ byUuid: { ...s.byUuid, [uuid]: selections } })),
}));
```

(Confirm `zustand`'s `create` import style matches the other stores, e.g. `packages/web/src/stores/tabs.ts`. Match whatever that file uses.)

- [ ] **Step 2: Write the failing interactive tests (extend `AskQuestionView.test.tsx`)**

```tsx
import { render, screen, fireEvent, act } from '@testing-library/react';
import { vi } from 'vitest';
import { api } from '../../../api/client';
import { useQuestionAnswers } from '../../../stores/questionAnswers';

test('clicking a single-select option submits keystrokes for that option', () => {
  useQuestionAnswers.setState({ byUuid: {} });
  const spy = vi.spyOn(api, 'sendInput').mockResolvedValue(undefined as any);
  render(<AskQuestionView tool={tool} answerable={true} terminalId="t1" onAnswerInTerminal={() => {}} />);
  fireEvent.click(screen.getByText('Option B')); // index 1 → DOWN + ENTER
  expect(spy).toHaveBeenCalledWith('t1', '\x1b[B\r');
  spy.mockRestore();
});

test('not answerable: clicking does not send input', () => {
  const spy = vi.spyOn(api, 'sendInput').mockResolvedValue(undefined as any);
  render(<AskQuestionView tool={tool} answerable={false} terminalId="t1" onAnswerInTerminal={() => {}} />);
  fireEvent.click(screen.getByText('Option A'));
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test('after submit with no result within 6s, shows an Answer in Terminal action', () => {
  vi.useFakeTimers();
  useQuestionAnswers.setState({ byUuid: {} });
  vi.spyOn(api, 'sendInput').mockResolvedValue(undefined as any);
  const onTerm = vi.fn();
  render(<AskQuestionView tool={tool} answerable={true} terminalId="t1" onAnswerInTerminal={onTerm} />);
  fireEvent.click(screen.getByText('Option A'));
  act(() => { vi.advanceTimersByTime(6100); });
  fireEvent.click(screen.getByText(/Answer in Terminal/));
  expect(onTerm).toHaveBeenCalled();
  vi.useRealTimers();
});
```

- [ ] **Step 3: Run the tests to verify the new ones fail**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-web exec vitest run src/components/tabs/toolviews/AskQuestionView.test.tsx`
Expected: the read-only test still passes; the three new tests FAIL (no submit wiring yet).

- [ ] **Step 4: Implement interactivity in `AskQuestionView.tsx`**

Replace the file with the interactive version:

```tsx
import { useEffect, useState } from 'react';
import type { ConvItem } from '../../../api/types';
import { api } from '../../../api/client';
import { parseQuestions, buildAnswerInput, type AskQuestion } from './answerInput';
import { useQuestionAnswers } from '../../../stores/questionAnswers';

export function AskQuestionView({ tool, result, answerable, terminalId, onAnswerInTerminal }: {
  tool: ConvItem; result?: ConvItem; answerable: boolean; terminalId: string; onAnswerInTerminal: () => void;
}) {
  const questions = parseQuestions(tool.toolInput);
  const uuid = tool.uuid ?? '';
  const submitted = useQuestionAnswers((s) => (uuid ? s.byUuid[uuid] : undefined));
  const [sel, setSel] = useState<number[][]>(() => questions.map(() => []));
  const [showFallback, setShowFallback] = useState(false);

  const isSubmitted = !!submitted || !!result;
  const active = answerable && !isSubmitted;

  // 6s after a local submit with no result yet, surface the Terminal fallback.
  useEffect(() => {
    if (!submitted || result) { setShowFallback(false); return; }
    const t = setTimeout(() => setShowFallback(true), 6000);
    return () => clearTimeout(t);
  }, [submitted, result]);

  if (!questions.length) return null;

  function toggle(qi: number, oi: number, multi: boolean) {
    setSel((prev) => {
      const next = prev.map((a) => a.slice());
      if (multi) {
        const at = next[qi].indexOf(oi);
        if (at >= 0) next[qi].splice(at, 1); else next[qi].push(oi);
      } else {
        next[qi] = [oi];
      }
      return next;
    });
  }

  function submit(selections: number[][]) {
    if (!active || !uuid) return;
    useQuestionAnswers.getState().submit(uuid, selections);
    void api.sendInput(terminalId, buildAnswerInput(questions, selections)).catch(() => {});
  }

  // chosen indices for highlight: prefer the optimistic record, else best-effort from result text.
  const chosen = submitted ?? chosenFromResult(questions, result?.text);
  const allAnswered = sel.every((a) => a.length > 0);

  return (
    <div style={{ border: '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)', borderRadius: 10, background: 'color-mix(in srgb, var(--color-accent) 6%, transparent)', overflow: 'hidden' }}>
      {questions.map((q, qi) => (
        <QuestionBlock
          key={qi} q={q}
          selected={chosen?.[qi] ?? sel[qi]}
          interactive={active}
          onToggle={(oi) => {
            if (!active) return;
            if (!q.multiSelect && questions.length === 1) { submit([[oi]]); return; }
            toggle(qi, oi, !!q.multiSelect);
          }}
        />
      ))}
      {active && !(questions.length === 1 && !questions[0].multiSelect) && (
        <div style={{ padding: '0 13px 12px' }}>
          <button onClick={() => submit(sel)} disabled={!allAnswered}
            style={{ background: allAnswered ? 'var(--color-accent)' : 'var(--color-elevated)', color: allAnswered ? '#06140B' : 'var(--color-text-tertiary)', border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 12.5, fontWeight: 600, cursor: allAnswered ? 'pointer' : 'default' }}>
            Submit
          </button>
        </div>
      )}
      {isSubmitted && !result && (
        <div style={{ padding: '0 13px 12px', fontSize: 12, color: 'var(--color-text-tertiary)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>Submitted — waiting for the thread…</span>
          {showFallback && <button onClick={onAnswerInTerminal} style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Answer in Terminal →</button>}
        </div>
      )}
    </div>
  );
}

function QuestionBlock({ q, selected, interactive, onToggle }: {
  q: AskQuestion; selected: number[]; interactive: boolean; onToggle: (oi: number) => void;
}) {
  return (
    <div style={{ padding: '11px 13px', borderTop: '1px solid var(--color-border)' }}>
      {q.header && <div style={{ display: 'inline-block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--color-accent)', border: '1px solid color-mix(in srgb, var(--color-accent) 40%, transparent)', borderRadius: 5, padding: '1px 6px', marginBottom: 6 }}>{q.header}</div>}
      <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 8 }}>{q.question}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {q.options.map((o, oi) => {
          const on = selected.includes(oi);
          return (
            <button key={oi} onClick={() => onToggle(oi)} disabled={!interactive}
              style={{ textAlign: 'left', border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-border)'}`, borderRadius: 8, padding: '8px 10px', background: on ? 'color-mix(in srgb, var(--color-accent) 14%, transparent)' : 'var(--color-elevated)', cursor: interactive ? 'pointer' : 'default' }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>{o.label}</div>
              {o.description && <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{o.description}</div>}
              {o.preview && <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 4, font: '400 11px var(--font-mono)', whiteSpace: 'pre-wrap' }}>{o.preview}</div>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function chosenFromResult(questions: AskQuestion[], text?: string): number[][] | null {
  if (!text) return null;
  let any = false;
  const out = questions.map((q) => {
    const idxs: number[] = [];
    q.options.forEach((o, i) => { if (o.label && text.includes(o.label)) { idxs.push(i); any = true; } });
    return idxs;
  });
  return any ? out : null;
}
```

- [ ] **Step 5: Run the tests + full web suite + typecheck + build**

Run:
```
cd /Users/davidwebber/Sites/dispatch
pnpm --filter dispatch-web exec vitest run
pnpm --filter dispatch-web exec tsc --noEmit
pnpm --filter dispatch-web build
```
Expected: all web tests PASS; tsc clean; build succeeds.

- [ ] **Step 6: Commit**

```bash
cd /Users/davidwebber/Sites/dispatch
git add packages/web/src/stores/questionAnswers.ts packages/web/src/components/tabs/toolviews/AskQuestionView.tsx packages/web/src/components/tabs/toolviews/AskQuestionView.test.tsx
git commit -m "feat(web): interactive AskUserQuestion — click to answer the live thread"
```

---

## Manual verification (acceptance gate for the keystroke scheme)

After Task 10, the web build is served by the running daemon on refresh (no restart needed). Verify against a real Claude thread:

1. In a Claude thread, get the agent to call `AskUserQuestion` (e.g. ask it to confirm an approach). Switch the thread to **View**.
2. The question card should show clickable options. Click an option (single-select) or select + **Submit** (multi/multiSelect).
3. Confirm the thread proceeds with the chosen answer and the card flips to the submitted/answered state.
4. If the thread does NOT advance: the keystroke scheme needs adjustment. Change ONLY `buildAnswerInput` in `packages/web/src/components/tabs/toolviews/answerInput.ts` — try the number-key scheme (send the option's digit `String(idx + 1)` then `\r` per question) — and update `answerInput.test.ts` expectations to match. The Terminal fallback covers users in the meantime.
5. Separately eyeball: a databricks/ShopifyQL query (table), a file Edit (red/green diff), a TodoWrite (checklist), and a WebFetch (URL + snippet).

## Self-Review notes (filled by the plan author)

- **Spec coverage:** rich query (Task 5), edits/diff (Task 6), todos (Task 7), web (Task 8); interactive AskUserQuestion render (Task 9) + answer/optimistic/fallback (Task 10); Claude-only gating (Task 9 wiring); fallback-safe registry (Tasks 4–5). Keystroke isolation + manual gate covered. No core changes — matches "Decision".
- **Ordering risk locked:** `WebSearch` is matched before the `hasQuery` SQL branch (both have a `query` field) — explicitly enforced and re-tested in Task 8 Step 5.
- **Type consistency:** `ToolView`, `getToolView`, `parseToolInput`, `buildAnswerInput`, `parseQuestions`, `AskQuestion`/`AskOption`, `useQuestionAnswers`/`submit` names are used identically across tasks.
