# Inline CSV Editing

**Date:** 2026-07-14
**Status:** Approved

## Purpose

`.csv` files today open in `FileEditorTab` as raw text in CodeMirror (unhighlighted — `languageFor()`
returns `[]` for `.csv`). They are editable, but only as text. This adds a **spreadsheet-style grid**
so cells can be edited inline, alongside the existing raw view.

## The Constraint That Shapes Everything

The hazard is not the grid — it is the **round-trip**.

Open a CSV, change one cell, save, and a naive implementation re-serializes the whole file: quoting
style shifts, `\r\n` collapses to `\n`, and `git diff` lights up every line. In Dispatch these files
sit in repos that coding agents diff and commit. A feature that corrupts a tracked data file, or
explodes its diff, is a feature nobody will trust twice.

**The correctness bar: edit one cell, and the diff shows exactly one changed line.**

Everything below follows from that.

## Design

### Parser — `packages/web/src/lib/csv.ts` (new)

Hand-rolled RFC 4180. This matches the codebase idiom (`toolviews/tableParse.ts` is a 43-line
hand-rolled parser with its own tests) and — critically — a parser we own can retain each row's
original source text, which a library cannot give us.

```ts
export interface CsvRow {
  cells: string[];
  /** The row's verbatim source text, excluding its line terminator. null for a row added in the grid. */
  raw: string | null;
}

export interface CsvDoc {
  rows: CsvRow[];          // rows[0] is the header
  delimiter: string;       // detected: ',' | ';' | '\t' | '|'
  eol: string;             // '\n' | '\r\n'
  bom: boolean;
  trailingNewline: boolean;
}

export function parseCsv(text: string): CsvDoc;
export function serializeCsv(doc: CsvDoc): string;
export function editCell(doc: CsvDoc, row: number, col: number, value: string): CsvDoc;
export function insertRow(doc: CsvDoc, at: number): CsvDoc;
export function deleteRow(doc: CsvDoc, at: number): CsvDoc;
```

**Fidelity mechanism.** `serializeCsv` emits each row's `raw` **verbatim** when it is non-null.
`editCell` sets the edited row's `raw` to `null`, so only that row is re-serialized. Rows are joined
with the document's own `eol`; the BOM and trailing newline are restored if the original had them.

Consequences, and these are the tests that matter most:
- `serializeCsv(parseCsv(text)) === text` — **byte-identical** for any input.
- Editing one cell changes exactly one line of output.

**Minimal quoting** (used only when re-serializing an edited row): quote a field iff it contains the
delimiter, a double quote, CR, or LF. Escape an embedded `"` as `""`.

**Must handle:** quoted fields containing the delimiter; **newlines embedded inside quoted fields**;
`""` escapes; CRLF; a leading BOM; and **ragged rows** (rows with differing cell counts — real CSVs
have them). Short rows must **not** be padded on save unless they were edited; padding them would
rewrite lines the user never touched.

**Delimiter detection:** count candidate delimiters (`,` `;` `\t` `|`) occurring *outside* quotes
across the first N lines; choose the one with the most consistent per-line count. `.tsv` defaults to
tab.

**Not reusing `tableParse.ts`:** its TSV path is a bare `split('\t')` with no quote handling
(`tableParse.ts:37`). Extending it would inherit precisely the bug this parser exists to prevent.

### Grid — `packages/web/src/components/tabs/CsvGrid.tsx` (new)

A dumb, props-only component: `({ doc, onChange }: { doc: CsvDoc; onChange: (next: CsvDoc) => void })`.

- Sticky header (row 0), row-number gutter. Styled after `ResultTable` (`QueryView.tsx:34`) so it
  looks native: mono 11.5px, sticky `th`, `var(--color-border)`.
- Click a cell to edit; **Enter/Tab commit and advance**, **Escape cancels**, arrows navigate.
- Add row / delete row.
- **Windowing:** render only the visible rows (fixed row height, computed from `scrollTop`, with
  overscan). The codebase's usual answer to volume is a hard cap (`QueryView.tsx:5`,
  `MAX_ROWS = 200`), but a cap here would mean "row 3,000 is uneditable." Windowing is ~40 lines and
  needs no dependency.
- **No separate size ceiling.** Windowing bounds the DOM, and a reparse cache in the grid means a
  file is parsed once rather than on every cell commit. The actual limit is the transport —
  `GET /files/read` returns the whole file as one UTF-8 JSON string — and that limit binds **Raw
  mode identically**, because CodeMirror receives the same string. A CSV-specific byte ceiling would
  therefore forbid nothing that isn't already unusable, so it is not worth the rule.

Column add/delete/reorder is **out of scope**. Header cells are editable, so renaming works.

### Host — extend `FileEditorTab`

`FileEditorTab` already owns a **View | Edit** mode toggle (for markdown), the fetch, the module-level
content cache, the save path, and the Cmd-S binding. CSV slots in as a **Table | Raw** toggle reusing
all of it. `FileEditorTab` stays a thin shell hosting "a text file with an optional rich view";
`CsvGrid` is the rich view, exactly as the rendered-markdown pane is.

**`content` (the string) remains the single source of truth.** The grid is a *projection*: it parses
`content` (memoized), and a cell commit produces a new `content` via `serializeCsv(editCell(...))`.

This is what keeps Table and Raw coherent — flip between them mid-edit and they cannot diverge,
because there is only one underlying value and only one thing to save. Re-serialization happens on
cell **commit** (Enter/Tab/blur), not per keystroke.

Detection: add `isCsv(path)` (`/\.(csv|tsv)$/i`) to `lib/fileType.ts`, plus a `csv`/`tsv` entry in
`fileMeta`'s icon map (today they fall through to the default `·` glyph).

### Unsaved-changes guard (fixing an existing bug)

Closing a file tab with unsaved edits **silently discards them today** — there is no dirty guard
anywhere in the app (`FileEditorTab`'s `dirty` is local state, lifted nowhere). A grid makes this
materially worse: twenty clicked cells *feel* committed.

- Lift a dirty flag into the tabs store.
- Confirm before closing a tab that is dirty.
- Add a `beforeunload` guard while any tab is dirty.

This also repairs the bug for ordinary text files, which is a real defect present today.

## Error Handling

- **Unparseable CSV** (e.g. an unterminated quote): the grid refuses and the file stays in Raw mode
  with a message. Never present a half-parsed grid over a file — an edit through a wrong parse
  corrupts data.
- **File above the grid ceiling:** Raw mode only, stated plainly.
- **Save failure:** surface it; do not clear the dirty flag.

## Testing

**Parser (the weight of the suite):**
- `serializeCsv(parseCsv(t)) === t`, byte-identical, over a table of inputs.
- One-cell edit produces exactly one changed line (diff the before/after line arrays).
- Quoted fields containing the delimiter; newlines embedded in quoted fields; `""` escapes.
- CRLF preserved; LF preserved; BOM preserved; trailing-newline presence/absence preserved.
- Ragged rows survive un-padded unless edited.
- Delimiter detection: `,`, `;`, `\t`, `|`; and a comma-bearing quoted field does not fool it.
- `insertRow` / `deleteRow` leave neighbouring rows byte-identical.

**Grid:** click-to-edit; Enter/Tab commit and advance; Escape cancels (value unchanged); add/delete
row; windowing renders only visible rows for a large document.

**Host:** a `.csv` shows the Table|Raw toggle; a `.md` still shows View|Edit; a `.ts` shows neither.
Switching Table→Raw mid-edit preserves the edit. Save writes the serialized string.

**Guard:** closing a dirty tab prompts; closing a clean tab does not.

## Out of Scope

- Column add / delete / reorder (header cells remain editable, so rename works).
- Sorting and filtering (they would imply reordering rows on save, which breaks the diff guarantee).
- Formulas, type inference, cell formatting.
- Server-side streaming/pagination of large CSVs.
