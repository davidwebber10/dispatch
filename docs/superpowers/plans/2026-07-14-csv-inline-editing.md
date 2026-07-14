# Inline CSV Editing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edit `.csv`/`.tsv` files as a spreadsheet grid inside Dispatch, with byte-faithful saves.

**Architecture:** A hand-rolled RFC-4180 parser (`lib/csv.ts`) that retains each row's verbatim source text, so an unedited row is re-emitted byte-for-byte and editing one cell produces a one-line diff. A dumb windowed grid (`CsvGrid.tsx`) renders it. `FileEditorTab` hosts it behind a **Table | Raw** toggle, reusing the mode machinery it already has for markdown's View | Edit. The file's `content` string stays the single source of truth; the grid is a projection of it.

**Tech Stack:** React 18 + Zustand + vitest/@testing-library. **No new dependencies** — the parser and the windowing are both hand-rolled, matching the codebase (`toolviews/tableParse.ts` is a hand-rolled parser with its own tests). Package manager is **pnpm**.

## Global Constraints

- **The round-trip is the feature.** `serializeCsv(parseCsv(text)) === text` must hold **byte-for-byte** for every input. Editing one cell must change exactly one line of output. A save that rewrites untouched lines is a defect, not a cosmetic issue — these files are tracked in git.
- **Never pad a ragged row.** Real CSVs have rows with fewer cells than the header. Padding them on save rewrites lines the user never touched.
- **Never present a grid over a file that failed to parse.** An edit through a wrong parse corrupts data. On a parse failure, refuse the grid and stay in Raw mode.
- **Do not extend `toolviews/tableParse.ts`.** Its TSV path is a bare `split('\t')` with no quote handling (`tableParse.ts:37`); building on it inherits exactly the bug this parser exists to prevent.
- **No new npm dependencies.**
- Run web tests with `npx vitest run <pattern>` from `packages/web` (the `pnpm --filter ... test -- <pat>` form does **not** actually filter). Full suite: `pnpm --filter dispatch-web test`. Typecheck: `pnpm --filter dispatch-web exec tsc -b --pretty false`.
- **Never** give `beforeEach`/`afterEach` a concise arrow body that returns a value — Vitest treats a returned function as a teardown hook and invokes it.

---

## File Structure

**Create**
- `packages/web/src/lib/csv.ts` — parser, serializer, and the row-level edit operations. The whole fidelity guarantee lives here.
- `packages/web/src/lib/csv.test.ts`
- `packages/web/src/components/tabs/CsvGrid.tsx` — dumb, props-only windowed grid.
- `packages/web/src/components/tabs/CsvGrid.test.tsx`

**Modify**
- `packages/web/src/lib/fileType.ts` — add `isCsv`; add `csv`/`tsv` to `fileMeta`'s icon map.
- `packages/web/src/components/tabs/FileEditorTab.tsx` — Table | Raw toggle; host `CsvGrid`; report dirty to the store.
- `packages/web/src/stores/tabs.ts` — `dirtyTabs`, `setTabDirty`, and a confirm inside `closeTab`.
- `packages/web/src/stores/tabs.test.ts` (or create) — guard tests.
- `packages/web/src/App.tsx` — `beforeunload` guard while any tab is dirty.

---

### Task 1: The CSV parser — `lib/csv.ts`

**Files:**
- Create: `packages/web/src/lib/csv.ts`, `packages/web/src/lib/csv.test.ts`

**Interfaces:**
- Produces:
  - `interface CsvRow { cells: string[]; raw: string | null }`
  - `interface CsvDoc { rows: CsvRow[]; delimiter: string; eol: string; bom: boolean; trailingNewline: boolean }`
  - `parseCsv(text: string, path?: string): CsvDoc` — throws on malformed input (unterminated quote)
  - `serializeCsv(doc: CsvDoc): string`
  - `editCell(doc: CsvDoc, row: number, col: number, value: string): CsvDoc`
  - `insertRow(doc: CsvDoc, at: number): CsvDoc`
  - `deleteRow(doc: CsvDoc, at: number): CsvDoc`
  - `columnCount(doc: CsvDoc): number`

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/lib/csv.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseCsv, serializeCsv, editCell, insertRow, deleteRow, columnCount } from './csv';

/** The load-bearing property: parse then serialize must return the input untouched. */
describe('round-trip fidelity', () => {
  const cases: [string, string][] = [
    ['simple', 'a,b,c\n1,2,3\n'],
    ['no trailing newline', 'a,b,c\n1,2,3'],
    ['CRLF', 'a,b,c\r\n1,2,3\r\n'],
    ['BOM', '﻿a,b,c\n1,2,3\n'],
    ['quoted field with a comma', 'name,note\n"Smith, John",hi\n'],
    ['escaped quotes', 'a,b\n"He said ""hi""",2\n'],
    ['newline inside a quoted field', 'a,b\n"line1\nline2",2\n'],
    ['ragged rows', 'a,b,c\n1,2\n3,4,5,6\n'],
    ['empty fields', 'a,b,c\n,,\n'],
    ['redundantly quoted fields', '"a","b"\n"1","2"\n'],
    ['semicolons', 'a;b;c\n1;2;3\n'],
    ['tabs', 'a\tb\tc\n1\t2\t3\n'],
    ['empty file', ''],
    ['header only', 'a,b,c\n'],
  ];
  it.each(cases)('%s round-trips byte-for-byte', (_name, text) => {
    expect(serializeCsv(parseCsv(text))).toBe(text);
  });
});

describe('parse', () => {
  it('splits quoted fields containing the delimiter', () => {
    const d = parseCsv('name,note\n"Smith, John",hi\n');
    expect(d.rows[1].cells).toEqual(['Smith, John', 'hi']);
  });

  it('unescapes doubled quotes', () => {
    const d = parseCsv('a,b\n"He said ""hi""",2\n');
    expect(d.rows[1].cells).toEqual(['He said "hi"', '2']);
  });

  it('keeps a newline embedded in a quoted field inside one cell', () => {
    const d = parseCsv('a,b\n"line1\nline2",2\n');
    expect(d.rows).toHaveLength(2);            // NOT 3 — the newline is data, not a row break
    expect(d.rows[1].cells).toEqual(['line1\nline2', '2']);
  });

  it('does not pad ragged rows', () => {
    const d = parseCsv('a,b,c\n1,2\n');
    expect(d.rows[1].cells).toEqual(['1', '2']); // length 2, not 3
    expect(columnCount(d)).toBe(3);              // the GRID is 3 wide; the ROW is not
  });

  it('records the document shape', () => {
    const d = parseCsv('﻿a;b\r\n1;2\r\n');
    expect(d).toMatchObject({ delimiter: ';', eol: '\r\n', bom: true, trailingNewline: true });
  });

  it('is not fooled by a delimiter inside a quoted field', () => {
    // Four commas but only one real semicolon-free structure: comma must still win.
    const d = parseCsv('a,b\n"x;y;z;w",2\n');
    expect(d.delimiter).toBe(',');
    expect(d.rows[1].cells).toEqual(['x;y;z;w', '2']);
  });

  it('defaults a .tsv file to tab', () => {
    expect(parseCsv('a\tb\n1\t2\n', 'data.tsv').delimiter).toBe('\t');
  });

  it('throws on an unterminated quote rather than guessing', () => {
    expect(() => parseCsv('a,b\n"unterminated,2\n')).toThrow();
  });
});

describe('editCell', () => {
  it('changes exactly one line and leaves every other byte alone', () => {
    const text = 'a,b,c\n1,2,3\n4,5,6\n';
    const out = serializeCsv(editCell(parseCsv(text), 2, 1, 'X'));
    expect(out).toBe('a,b,c\n1,2,3\n4,X,6\n');
    // and prove it line-by-line: only index 2 differs
    const before = text.split('\n'), after = out.split('\n');
    const changed = before.map((l, i) => (l === after[i] ? null : i)).filter((i) => i !== null);
    expect(changed).toEqual([2]);
  });

  it('preserves an untouched row that was redundantly quoted', () => {
    // Row 1 stays "1","2" verbatim — we must NOT normalise it to 1,2
    const text = '"a","b"\n"1","2"\n"3","4"\n';
    const out = serializeCsv(editCell(parseCsv(text), 2, 0, 'X'));
    expect(out).toBe('"a","b"\n"1","2"\nX,4\n');
  });

  it('quotes a new value only when it needs quoting', () => {
    const d = parseCsv('a,b\n1,2\n');
    expect(serializeCsv(editCell(d, 1, 0, 'plain'))).toBe('a,b\nplain,2\n');
    expect(serializeCsv(editCell(d, 1, 0, 'has,comma'))).toBe('a,b\n"has,comma",2\n');
    expect(serializeCsv(editCell(d, 1, 0, 'has"quote'))).toBe('a,b\n"has""quote",2\n');
    expect(serializeCsv(editCell(d, 1, 0, 'has\nnewline'))).toBe('a,b\n"has\nnewline",2\n');
  });

  it('pads a ragged row only when you edit past its end', () => {
    const d = parseCsv('a,b,c\n1,2\n');
    expect(serializeCsv(editCell(d, 1, 2, 'Z'))).toBe('a,b,c\n1,2,Z\n');
  });

  it('uses the document delimiter and eol for the rewritten row', () => {
    const d = parseCsv('a;b\r\n1;2\r\n');
    expect(serializeCsv(editCell(d, 1, 1, 'X'))).toBe('a;b\r\n1;X\r\n');
  });
});

describe('insertRow / deleteRow', () => {
  it('inserts an empty row without touching its neighbours', () => {
    const out = serializeCsv(insertRow(parseCsv('a,b\n1,2\n3,4\n'), 2));
    expect(out).toBe('a,b\n1,2\n,\n3,4\n');
  });

  it('deletes a row without touching its neighbours', () => {
    const out = serializeCsv(deleteRow(parseCsv('a,b\n1,2\n3,4\n'), 1));
    expect(out).toBe('a,b\n3,4\n');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd packages/web && npx vitest run csv`
Expected: FAIL — cannot resolve `./csv`.

- [ ] **Step 3: Implement**

Create `packages/web/src/lib/csv.ts`:

```ts
/**
 * RFC 4180 CSV, with one addition that is the whole point of the file: every row keeps its
 * VERBATIM source text (`raw`). serializeCsv re-emits that text untouched for any row you did
 * not edit, so:
 *
 *   serializeCsv(parseCsv(text)) === text        // byte-for-byte, always
 *   editing one cell changes exactly one line    // clean git diffs
 *
 * That matters because these files live in repos that coding agents diff and commit. A save that
 * renormalises quoting or line endings across the whole file would make every edit unreviewable.
 *
 * Hand-rolled rather than a library because a library hands back cells and throws the original
 * bytes away — and the original bytes ARE the feature.
 */

export interface CsvRow {
  cells: string[];
  /** This row's source text, excluding its line terminator. null for a row created in the grid. */
  raw: string | null;
}

export interface CsvDoc {
  rows: CsvRow[];
  delimiter: string;
  eol: string;
  bom: boolean;
  trailingNewline: boolean;
}

const BOM = '﻿';
const CANDIDATES = [',', ';', '\t', '|'];

/** Widest row — the grid's column count. Rows themselves stay ragged; we never pad them. */
export function columnCount(doc: CsvDoc): number {
  return doc.rows.reduce((n, r) => Math.max(n, r.cells.length), 0);
}

/**
 * Count a candidate delimiter's occurrences OUTSIDE quoted fields. A naive count would pick ';'
 * for `a,b\n"x;y;z;w",2` — the semicolons are data, not structure.
 */
function countOutsideQuotes(text: string, delim: string): number {
  let n = 0, inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') { i++; continue; }  // escaped quote
      inQuotes = !inQuotes;
    } else if (!inQuotes && c === delim) n++;
  }
  return n;
}

function detectDelimiter(text: string, path?: string): string {
  if (path && /\.tsv$/i.test(path)) return '\t';
  const sample = text.slice(0, 64 * 1024);
  let best = ',', bestCount = 0;
  for (const d of CANDIDATES) {
    const n = countOutsideQuotes(sample, d);
    if (n > bestCount) { best = d; bestCount = n; }
  }
  return best;
}

/** Throws on malformed input (an unterminated quote) — never guess at a file we'll write back. */
export function parseCsv(text: string, path?: string): CsvDoc {
  const bom = text.startsWith(BOM);
  let body = bom ? text.slice(BOM.length) : text;

  const eol = /\r\n/.test(body) ? '\r\n' : '\n';
  const trailingNewline = body.endsWith(eol);
  if (trailingNewline) body = body.slice(0, -eol.length);

  const delimiter = detectDelimiter(body, path);

  const rows: CsvRow[] = [];
  if (body.length === 0 && !trailingNewline) {
    return { rows, delimiter, eol, bom, trailingNewline };
  }

  let cells: string[] = [];
  let field = '';
  let rowStart = 0;
  let inQuotes = false;

  for (let i = 0; i < body.length; i++) {
    const c = body[i];

    if (inQuotes) {
      if (c === '"') {
        if (body[i + 1] === '"') { field += '"'; i++; }   // "" is a literal quote
        else inQuotes = false;
      } else field += c;
      continue;
    }

    if (c === '"' && field === '') { inQuotes = true; continue; }

    if (c === delimiter) { cells.push(field); field = ''; continue; }

    // A row break — but only outside quotes; a newline inside quotes is data.
    if (c === '\n' || (c === '\r' && body[i + 1] === '\n')) {
      const end = i;
      cells.push(field);
      rows.push({ cells, raw: body.slice(rowStart, end) });
      cells = []; field = '';
      i += c === '\r' ? 1 : 0;
      rowStart = i + 1;
      continue;
    }

    field += c;
  }

  if (inQuotes) throw new Error('Malformed CSV: unterminated quoted field');

  cells.push(field);
  rows.push({ cells, raw: body.slice(rowStart) });

  return { rows, delimiter, eol, bom, trailingNewline };
}

/** Quote a field only when it must be quoted — matches what nearly every CSV writer emits. */
function quoteField(value: string, delimiter: string): string {
  const needs = value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r');
  return needs ? `"${value.replace(/"/g, '""')}"` : value;
}

function serializeRow(row: CsvRow, delimiter: string): string {
  // The fidelity guarantee: an untouched row is re-emitted exactly as it arrived.
  if (row.raw !== null) return row.raw;
  return row.cells.map((c) => quoteField(c, delimiter)).join(delimiter);
}

export function serializeCsv(doc: CsvDoc): string {
  const body = doc.rows.map((r) => serializeRow(r, doc.delimiter)).join(doc.eol);
  return (doc.bom ? BOM : '') + body + (doc.trailingNewline && doc.rows.length ? doc.eol : '');
}

/** Setting `raw` to null is what marks a row "rewrite me" — every other row stays byte-identical. */
export function editCell(doc: CsvDoc, row: number, col: number, value: string): CsvDoc {
  const rows = doc.rows.slice();
  const target = rows[row];
  if (!target) return doc;
  const cells = target.cells.slice();
  while (cells.length <= col) cells.push('');   // only widen the row you actually edited
  cells[col] = value;
  rows[row] = { cells, raw: null };
  return { ...doc, rows };
}

export function insertRow(doc: CsvDoc, at: number): CsvDoc {
  const width = Math.max(1, columnCount(doc));
  const rows = doc.rows.slice();
  rows.splice(at, 0, { cells: Array(width).fill(''), raw: null });
  return { ...doc, rows };
}

export function deleteRow(doc: CsvDoc, at: number): CsvDoc {
  const rows = doc.rows.slice();
  rows.splice(at, 1);
  return { ...doc, rows };
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/web && npx vitest run csv`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/csv.ts packages/web/src/lib/csv.test.ts
git commit -m "feat(web): byte-faithful CSV parser — untouched rows re-emit verbatim"
```

---

### Task 2: `CsvGrid` — the windowed, editable grid

**Files:**
- Create: `packages/web/src/components/tabs/CsvGrid.tsx`, `packages/web/src/components/tabs/CsvGrid.test.tsx`

**Interfaces:**
- Consumes: `CsvDoc`, `parseCsv`, `serializeCsv`, `editCell`, `insertRow`, `deleteRow`, `columnCount` (Task 1).
- Produces: `CsvGrid({ content, onChange }: { content: string; onChange: (next: string) => void })`
  and `export const ROW_H = 28;`

> **Why the component takes a STRING, not a `CsvDoc`:** the file's text is the single source of
> truth (`FileEditorTab` owns it, saves it, and shares it with the raw CodeMirror view). The grid is
> a *projection* of that string. Keeping a parallel `CsvDoc` in component state would let the grid
> and the raw editor silently diverge.
>
> **The reparse cache is not an optimisation, it is required:** without it, every cell commit would
> re-parse the whole file (we hand back a new string, which flows straight back in as a new
> `content`). The `lastRef` below pre-seeds the memo with the doc we already hold, so a self-inflicted
> change costs nothing and only an *external* change (an edit in the Raw tab) triggers a reparse.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/components/tabs/CsvGrid.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CsvGrid } from './CsvGrid';

const CSV = 'name,qty\napples,3\npears,5\n';

describe('CsvGrid', () => {
  it('renders the header and the cells', () => {
    render(<CsvGrid content={CSV} onChange={() => {}} />);
    expect(screen.getByText('name')).toBeInTheDocument();
    expect(screen.getByText('apples')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('commits a cell edit on Enter and emits the new CSV text', () => {
    const onChange = vi.fn();
    render(<CsvGrid content={CSV} onChange={onChange} />);

    fireEvent.doubleClick(screen.getByText('apples'));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bananas' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Only the edited line changes; the header and the pears row stay byte-identical.
    expect(onChange).toHaveBeenCalledWith('name,qty\nbananas,3\npears,5\n');
  });

  it('quotes a committed value that contains the delimiter', () => {
    const onChange = vi.fn();
    render(<CsvGrid content={CSV} onChange={onChange} />);
    fireEvent.doubleClick(screen.getByText('apples'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'apples, green' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('name,qty\n"apples, green",3\npears,5\n');
  });

  it('Escape cancels the edit and emits nothing', () => {
    const onChange = vi.fn();
    render(<CsvGrid content={CSV} onChange={onChange} />);
    fireEvent.doubleClick(screen.getByText('apples'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'discard me' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('apples')).toBeInTheDocument();
  });

  it('adds a row', () => {
    const onChange = vi.fn();
    render(<CsvGrid content={CSV} onChange={onChange} />);
    fireEvent.click(screen.getByTitle('Add row'));
    expect(onChange).toHaveBeenCalledWith('name,qty\napples,3\npears,5\n,\n');
  });

  it('deletes a row without disturbing the others', () => {
    const onChange = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<CsvGrid content={CSV} onChange={onChange} />);
    fireEvent.click(screen.getAllByTitle('Delete row')[0]); // first DATA row (apples)
    expect(onChange).toHaveBeenCalledWith('name,qty\npears,5\n');
  });

  it('refuses to render a grid over a file it could not parse', () => {
    render(<CsvGrid content={'a,b\n"unterminated,2\n'} onChange={() => {}} />);
    expect(screen.getByText(/could not be parsed/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();   // never a half-parsed grid
  });

  it('windows the rows — a huge file renders only a slice of the DOM', () => {
    const big = 'a,b\n' + Array.from({ length: 20_000 }, (_, i) => `${i},${i}`).join('\n') + '\n';
    render(<CsvGrid content={big} onChange={() => {}} />);
    // 20k data rows exist in the doc but nowhere near that many <tr> are in the DOM.
    expect(screen.getAllByRole('row').length).toBeLessThan(200);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd packages/web && npx vitest run CsvGrid`
Expected: FAIL — cannot resolve `./CsvGrid`.

- [ ] **Step 3: Implement**

Create `packages/web/src/components/tabs/CsvGrid.tsx`:

```tsx
import { useMemo, useRef, useState } from 'react';
import { Plus, TrashSimple } from '@phosphor-icons/react';
import { parseCsv, serializeCsv, editCell, insertRow, deleteRow, columnCount, type CsvDoc } from '../../lib/csv';

export const ROW_H = 28;         // fixed row height — what makes windowing arithmetic possible
const OVERSCAN = 10;
const VIEWPORT_GUESS = 600;      // used before the first scroll measurement

/** Styles mirror ResultTable (toolviews/QueryView.tsx) so the grid looks native here. */
const TH: React.CSSProperties = {
  textAlign: 'left', padding: '5px 9px', borderBottom: '1px solid var(--color-border)',
  borderRight: '1px solid var(--color-border)', color: 'var(--color-text-secondary)',
  fontWeight: 600, position: 'sticky', top: 0, background: 'var(--color-pane)',
  whiteSpace: 'nowrap', height: ROW_H, boxSizing: 'border-box',
};
const TD: React.CSSProperties = {
  padding: '4px 9px', borderBottom: '1px solid var(--color-border)',
  borderRight: '1px solid var(--color-border)', color: 'var(--color-text-primary)',
  whiteSpace: 'nowrap', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis',
  height: ROW_H, boxSizing: 'border-box', cursor: 'cell',
};
const GUTTER: React.CSSProperties = {
  ...TD, color: 'var(--color-text-tertiary)', textAlign: 'right', cursor: 'default',
  background: 'var(--color-pane)', position: 'sticky', left: 0, width: 52, maxWidth: 52,
};

export function CsvGrid({ content, onChange }: { content: string; onChange: (next: string) => void }) {
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(VIEWPORT_GUESS);

  // Parse the incoming text — but reuse the doc we just produced ourselves rather than
  // re-parsing the whole file on every keystroke-commit. Only an EXTERNAL change (an edit made
  // in the Raw tab) actually re-parses.
  const lastRef = useRef<{ text: string; doc: CsvDoc } | null>(null);
  const parsed = useMemo(() => {
    if (lastRef.current && lastRef.current.text === content) return { doc: lastRef.current.doc, error: null as string | null };
    try {
      const doc = parseCsv(content);
      lastRef.current = { text: content, doc };
      return { doc, error: null as string | null };
    } catch (err: any) {
      return { doc: null, error: String(err?.message ?? err) };
    }
  }, [content]);

  // Never render a grid over a file we failed to parse — an edit through a wrong parse
  // would silently corrupt the user's data. Raw mode is still right there.
  if (!parsed.doc) {
    return (
      <div style={{ padding: 16, color: 'var(--color-text-secondary)', font: '400 12px var(--font-mono)' }}>
        This file could not be parsed as CSV ({parsed.error}). Switch to <strong>Raw</strong> to edit it as text.
      </div>
    );
  }

  const doc = parsed.doc;

  function commit(next: CsvDoc) {
    const text = serializeCsv(next);
    lastRef.current = { text, doc: next };   // pre-seed so the memo above doesn't re-parse
    onChange(text);
  }

  function startEdit(row: number, col: number) {
    setEditing({ row, col });
    setDraft(doc.rows[row]?.cells[col] ?? '');
  }

  function commitEdit(advance: 'down' | 'right' | null) {
    if (!editing) return;
    const { row, col } = editing;
    if (draft !== (doc.rows[row]?.cells[col] ?? '')) commit(editCell(doc, row, col, draft));
    setEditing(null);
    if (advance === 'down' && row + 1 < doc.rows.length) startEdit(row + 1, col);
    if (advance === 'right' && col + 1 < cols) startEdit(row, col + 1);
  }

  const cols = Math.max(1, columnCount(doc));
  const header = doc.rows[0];
  const dataCount = Math.max(0, doc.rows.length - 1);

  // Windowing: only the visible slice of data rows is in the DOM. A 100k-row CSV would
  // otherwise put 100k <tr> nodes on the page and lock the tab.
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const visible = Math.ceil(viewportH / ROW_H) + OVERSCAN * 2;
  const last = Math.min(dataCount, first + visible);
  const padTop = first * ROW_H;
  const padBottom = Math.max(0, (dataCount - last) * ROW_H);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div
        onScroll={(e) => { setScrollTop(e.currentTarget.scrollTop); setViewportH(e.currentTarget.clientHeight); }}
        style={{ flex: 1, minHeight: 0, overflow: 'auto' }}
      >
        <table style={{ borderCollapse: 'collapse', font: '400 11.5px var(--font-mono)', minWidth: '100%' }}>
          <thead>
            <tr>
              <th style={{ ...TH, ...GUTTER, position: 'sticky', top: 0, left: 0, zIndex: 2 }} />
              {Array.from({ length: cols }, (_, c) => (
                <th key={c} style={TH} onDoubleClick={() => startEdit(0, c)}>
                  {editing && editing.row === 0 && editing.col === c
                    ? <CellInput draft={draft} setDraft={setDraft} onCommit={commitEdit} onCancel={() => setEditing(null)} />
                    : (header?.cells[c] ?? '')}
                </th>
              ))}
              <th style={{ ...TH, width: 32 }} />
            </tr>
          </thead>
          <tbody>
            {padTop > 0 && <tr style={{ height: padTop }} aria-hidden />}
            {Array.from({ length: last - first }, (_, k) => {
              const di = first + k;          // index among DATA rows
              const ri = di + 1;             // index in doc.rows (0 is the header)
              return (
                <tr key={ri}>
                  <td style={GUTTER}>{ri}</td>
                  {Array.from({ length: cols }, (_, c) => (
                    <td key={c} style={TD} title={doc.rows[ri]?.cells[c] ?? ''} onDoubleClick={() => startEdit(ri, c)}>
                      {editing && editing.row === ri && editing.col === c
                        ? <CellInput draft={draft} setDraft={setDraft} onCommit={commitEdit} onCancel={() => setEditing(null)} />
                        : (doc.rows[ri]?.cells[c] ?? '')}
                    </td>
                  ))}
                  <td style={{ ...TD, width: 32, cursor: 'default' }}>
                    <button
                      title="Delete row"
                      onClick={() => { if (window.confirm(`Delete row ${ri}?`)) commit(deleteRow(doc, ri)); }}
                      style={{ background: 'none', border: 'none', color: 'var(--color-text-tertiary)', cursor: 'pointer', padding: 0 }}
                    >
                      <TrashSimple size={13} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {padBottom > 0 && <tr style={{ height: padBottom }} aria-hidden />}
          </tbody>
        </table>
      </div>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', borderTop: '1px solid var(--color-border)', color: 'var(--color-text-tertiary)', fontSize: 11 }}>
        <button
          title="Add row"
          onClick={() => commit(insertRow(doc, doc.rows.length))}
          style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: '1px solid var(--color-border)', borderRadius: 6, color: 'var(--color-text-secondary)', cursor: 'pointer', padding: '3px 8px', fontSize: 11 }}
        >
          <Plus size={12} /> Add row
        </button>
        <span>{dataCount} rows × {cols} columns</span>
      </div>
    </div>
  );
}

function CellInput({ draft, setDraft, onCommit, onCancel }: {
  draft: string;
  setDraft: (v: string) => void;
  onCommit: (advance: 'down' | 'right' | null) => void;
  onCancel: () => void;
}) {
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); onCommit('down'); }
        else if (e.key === 'Tab') { e.preventDefault(); onCommit('right'); }
        else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      }}
      style={{ width: '100%', background: 'var(--color-terminal)', border: '1px solid var(--color-accent)', borderRadius: 3, color: 'var(--color-text-primary)', font: '400 11.5px var(--font-mono)', padding: '1px 3px', outline: 'none' }}
    />
  );
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/web && npx vitest run CsvGrid`
Expected: PASS (7)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/tabs/CsvGrid.tsx packages/web/src/components/tabs/CsvGrid.test.tsx
git commit -m "feat(web): windowed, editable CSV grid"
```

---

### Task 3: Host it — `isCsv` + the Table | Raw toggle

**Files:**
- Modify: `packages/web/src/lib/fileType.ts` (add `isCsv`; add `csv`/`tsv` to `fileMeta`)
- Modify: `packages/web/src/components/tabs/FileEditorTab.tsx`
- Create: `packages/web/src/components/tabs/FileEditorTab.test.tsx`

**Interfaces:**
- Consumes: `CsvGrid` (Task 2).
- Produces: `isCsv(path: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/tabs/FileEditorTab.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileEditorTab } from './FileEditorTab';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';

function tab(path: string): Terminal {
  return { id: 't1', sessionId: 's1', type: 'file', label: path, config: { path } } as unknown as Terminal;
}

describe('FileEditorTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'writeFile').mockResolvedValue({ ok: true, path: 'x' } as never);
  });

  it('shows a Table|Raw toggle and the grid for a .csv', async () => {
    vi.spyOn(api, 'readFile').mockResolvedValue({ content: 'name,qty\napples,3\n', path: 'd.csv' });
    render(<FileEditorTab terminal={tab('d.csv')} />);

    expect(await screen.findByText('table')).toBeInTheDocument();
    expect(screen.getByText('raw')).toBeInTheDocument();
    expect(await screen.findByText('apples')).toBeInTheDocument();  // the grid, not raw text
  });

  it('keeps View|Edit for markdown and offers no toggle for code', async () => {
    vi.spyOn(api, 'readFile').mockResolvedValue({ content: '# hi', path: 'a.md' });
    const { unmount } = render(<FileEditorTab terminal={tab('a.md')} />);
    expect(await screen.findByText('view')).toBeInTheDocument();
    expect(screen.queryByText('table')).toBeNull();
    unmount();

    vi.spyOn(api, 'readFile').mockResolvedValue({ content: 'const x = 1', path: 'a.ts' });
    render(<FileEditorTab terminal={tab('a.ts')} />);
    await waitFor(() => expect(screen.queryByText('view')).toBeNull());
    expect(screen.queryByText('table')).toBeNull();
  });

  it('a grid edit marks the file dirty and saves the serialized CSV', async () => {
    vi.spyOn(api, 'readFile').mockResolvedValue({ content: 'name,qty\napples,3\n', path: 'd.csv' });
    render(<FileEditorTab terminal={tab('d.csv')} />);

    fireEvent.doubleClick(await screen.findByText('apples'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'bananas' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText('● unsaved')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(api.writeFile).toHaveBeenCalledWith('s1', 'd.csv', 'name,qty\nbananas,3\n'),
    );
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd packages/web && npx vitest run FileEditorTab`
Expected: FAIL — no `table`/`raw` toggle; a `.csv` renders CodeMirror.

- [ ] **Step 3: Implement**

In `packages/web/src/lib/fileType.ts`, add after `isSvg`:

```ts
/**
 * Tabular text we can offer a grid for. `.tsv` rides along free — the parser detects the
 * delimiter, so the only difference is the default.
 */
export function isCsv(path: string): boolean {
  return /\.(csv|tsv)$/i.test(path);
}
```

and add to `fileMeta`'s map (they fall through to the default `·` glyph today):

```ts
    csv: { glyph: 'CSV', color: '#7FBE6E' }, tsv: { glyph: 'CSV', color: '#7FBE6E' },
```

In `packages/web/src/components/tabs/FileEditorTab.tsx`:

1. Extend the imports:

```ts
import { isCsv, isMarkdown, languageFor } from '../../lib/fileType';
import { CsvGrid } from './CsvGrid';
```

2. Replace the `md` line and the `mode` state (lines 20 and 30) with:

```ts
  const md = isMarkdown(path);
  const csv = isCsv(path);
  const rich = md || csv;              // has a second, non-CodeMirror view
```
```ts
  const [mode, setMode] = useState<'edit' | 'view'>(rich ? 'view' : 'edit');
```

3. The CodeMirror mount effect (line 59) currently reads `if (mode !== 'edit' || !loaded || !host.current) return;` — leave it exactly as is. In `view` mode for a CSV the editor is not mounted, so `save()`'s fallback to `content` (line 76) is already correct: `content` is what the grid mutates.

4. Replace the `tab` helper (line 89) so the toggle can be labelled per file type:

```ts
  // markdown reads "view | edit"; a CSV reads "table | raw" — same two modes underneath.
  const label = (m: 'view' | 'edit') => (csv ? (m === 'view' ? 'table' : 'raw') : m);
  const tab = (m: 'view' | 'edit') => (
    <button key={m} onClick={() => setMode(m)} style={{ padding: '3px 12px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 12, textTransform: 'capitalize', background: mode === m ? 'var(--color-accent)' : 'transparent', color: mode === m ? '#08240F' : 'var(--color-text-secondary)', fontWeight: mode === m ? 600 : 400 }}>{label(m)}</button>
  );
```

5. Change the toggle's render condition (line 98) from `{md && (` to `{rich && (`.

6. Replace the body ternary (lines 105-113) with a three-way branch. The grid hands back a whole
   new CSV string, which becomes `content` — the single source of truth the Raw view and `save()`
   both already read:

```tsx
      {csv && mode === 'view'
        ? <CsvGrid content={content} onChange={(next) => { setContent(next); setDirty(true); }} />
        : md && mode === 'view'
          ? <div
              ref={mdView}
              className="md-view"
              onScroll={(e) => mdScroll.set(terminal.id, e.currentTarget.scrollTop)}
              style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '14px 28px' }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
            />
          : <div ref={host} style={{ flex: 1, minHeight: 0, overflow: 'auto' }} />}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/web && npx vitest run FileEditorTab csv CsvGrid`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/fileType.ts packages/web/src/components/tabs/FileEditorTab.tsx packages/web/src/components/tabs/FileEditorTab.test.tsx
git commit -m "feat(web): Table | Raw toggle for CSV files"
```

---

### Task 4: Unsaved-changes guard

**Files:**
- Modify: `packages/web/src/stores/tabs.ts`
- Modify: `packages/web/src/components/tabs/FileEditorTab.tsx`
- Modify: `packages/web/src/App.tsx`
- Create: `packages/web/src/stores/tabs-dirty.test.ts`

**Interfaces:**
- Produces: `useTabs` gains `dirtyTabs: Record<string, boolean>` and `setTabDirty(id: string, dirty: boolean): void`; `closeTab(id: string, opts?: { force?: boolean })`.

> **Why the guard belongs in the store:** `closeTab` is called from **eight** UI sites (`TabBar.tsx:21,28`,
> `GroupedTabBar.tsx:119,140,165,183,298,313`, `panes/store.ts:118`). Guarding each one would leave a hole
> the first time someone adds a ninth. The store action is the single choke point.
>
> **Why `force` exists:** `useTabs.applyEvent` also calls `closeTab` on a `terminal:removed` server event
> (`tabs.ts:172`). Prompting "save your changes?" for a file the server has already deleted is nonsense —
> that path passes `force: true`.
>
> This fixes a bug that exists **today**: closing a dirty file tab silently discards the edits.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/stores/tabs-dirty.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTabs } from './tabs';

describe('unsaved-changes guard', () => {
  beforeEach(() => {
    useTabs.setState({ openTabIds: ['t1', 't2'], activeTabId: 't1', tabSession: { t1: 's1', t2: 's1' }, dirtyTabs: {} });
    vi.restoreAllMocks();
  });

  it('closes a clean tab without prompting', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    useTabs.getState().closeTab('t1');
    expect(confirm).not.toHaveBeenCalled();
    expect(useTabs.getState().openTabIds).toEqual(['t2']);
  });

  it('prompts before closing a dirty tab, and keeps it open if you decline', () => {
    useTabs.getState().setTabDirty('t1', true);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    useTabs.getState().closeTab('t1');

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(useTabs.getState().openTabIds).toEqual(['t1', 't2']);   // still open — nothing lost
  });

  it('closes a dirty tab when you confirm, and forgets its dirty flag', () => {
    useTabs.getState().setTabDirty('t1', true);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    useTabs.getState().closeTab('t1');

    expect(useTabs.getState().openTabIds).toEqual(['t2']);
    expect(useTabs.getState().dirtyTabs.t1).toBeUndefined();
  });

  it('does not prompt when the server already removed the terminal', () => {
    useTabs.getState().setTabDirty('t1', true);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    useTabs.getState().closeTab('t1', { force: true });

    expect(confirm).not.toHaveBeenCalled();       // the file is gone; there is nothing to save
    expect(useTabs.getState().openTabIds).toEqual(['t2']);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd packages/web && npx vitest run tabs-dirty`
Expected: FAIL — `setTabDirty` is not a function.

- [ ] **Step 3: Implement**

In `packages/web/src/stores/tabs.ts`, add to the `TabsState` interface:

```ts
  /** Tabs with unsaved edits — closing one prompts first. */
  dirtyTabs: Record<string, boolean>;
  setTabDirty: (id: string, dirty: boolean) => void;
```

and change the `closeTab` signature in the interface:

```ts
  closeTab: (id: string, opts?: { force?: boolean }) => void;
```

Add the initial state next to `openTabIds: []`:

```ts
  dirtyTabs: {},
  setTabDirty: (id, dirty) => {
    const next = { ...get().dirtyTabs };
    if (dirty) next[id] = true; else delete next[id];
    set({ dirtyTabs: next });
  },
```

Replace `closeTab` (line 129):

```ts
  closeTab: (id, opts) => {
    // Single choke point for EVERY close path (tab bar, grouped tab bar, close-group), so a new
    // call site can't accidentally bypass the guard. `force` is for the server-initiated
    // terminal:removed event, where the file is already gone and prompting would be absurd.
    if (!opts?.force && get().dirtyTabs[id]) {
      if (!window.confirm('This file has unsaved changes. Close the tab and discard them?')) return;
    }
    const { openTabIds, activeTabId, tabSession } = get();
    const idx = openTabIds.indexOf(id);
    const next = openTabIds.filter((x) => x !== id);
    const active = activeTabId === id ? (next[Math.min(idx, next.length - 1)] ?? null) : activeTabId;
    const ts = { ...tabSession }; delete ts[id];
    const dirtyTabs = { ...get().dirtyTabs }; delete dirtyTabs[id];
    set({ openTabIds: next, activeTabId: active, tabSession: ts, dirtyTabs });
    persist(get());
  },
```

and in `applyEvent`, change the `terminal:removed` branch (line 172) to force:

```ts
      get().closeTab(e.terminalId, { force: true });
```

In `packages/web/src/components/tabs/FileEditorTab.tsx`, mirror the local `dirty` flag into the
store so the tab bar's close button can see it. Add the import:

```ts
import { useTabs } from '../../stores/tabs';
```

and an effect (place it next to the Cmd-S effect), which also clears the flag on unmount:

```ts
  // Publish dirtiness to the tabs store — closeTab() reads it to guard the close button.
  useEffect(() => {
    useTabs.getState().setTabDirty(terminal.id, dirty);
    return () => useTabs.getState().setTabDirty(terminal.id, false);
  }, [terminal.id, dirty]);
```

In `packages/web/src/App.tsx`, add a `beforeunload` guard alongside the other bootstrap effects:

```ts
  // Browser close / refresh with unsaved file edits — the tab-close guard can't see this one.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (Object.keys(useTabs.getState().dirtyTabs).length === 0) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
```

(`useTabs` is already imported in `App.tsx`; if not, add it.)

- [ ] **Step 4: Run tests**

Run: `cd packages/web && npx vitest run tabs-dirty FileEditorTab`
Expected: PASS

- [ ] **Step 5: Full suite + typecheck**

```bash
pnpm --filter dispatch-web test
pnpm --filter dispatch-web exec tsc -b --pretty false
```
Expected: all green, zero type errors. (Existing tabs tests must still pass — `closeTab`'s new
second parameter is optional, so every existing call site still compiles.)

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/stores/tabs.ts packages/web/src/stores/tabs-dirty.test.ts packages/web/src/components/tabs/FileEditorTab.tsx packages/web/src/App.tsx
git commit -m "fix(web): confirm before closing a tab with unsaved edits"
```

---

## Self-Review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| Hand-rolled RFC-4180 parser retaining each row's verbatim source | 1 |
| Byte-identical no-op round-trip; one-cell edit → one-line diff | 1 |
| Quoted delimiters, embedded newlines, `""`, CRLF, BOM, ragged rows | 1 |
| Delimiter detection (`,` `;` `\t` `|`), not fooled by quoted data | 1 |
| Minimal quoting on rewritten rows only | 1 |
| Windowed grid; click-to-edit; Enter/Tab/Escape; add/delete row | 2 |
| Refuse the grid on a parse failure (never a half-parsed grid) | 2 |
| `content` string stays the single source of truth; grid is a projection | 2, 3 |
| `isCsv` + `fileMeta` icon entries | 3 |
| Table \| Raw toggle reusing the markdown mode machinery | 3 |
| Unsaved-changes guard (tab close + beforeunload) | 4 |

No gaps.

**Type consistency** — `CsvDoc`, `CsvRow`, `parseCsv`, `serializeCsv`, `editCell`, `insertRow`,
`deleteRow`, `columnCount`, `isCsv`, `CsvGrid({ content, onChange })`, `setTabDirty`,
`closeTab(id, opts?)` are used identically in every task that references them.

**Out of scope (from the spec)** — column add/delete/reorder; sorting/filtering (they would reorder
rows on save and destroy the diff guarantee); formulas; type inference; server-side pagination.
