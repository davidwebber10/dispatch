/**
 * RFC 4180 CSV, with one addition that is the whole point of the file: every row keeps its
 * VERBATIM source text (`raw`) AND its own line terminator (`eol`). serializeCsv re-emits both
 * untouched for any row you did not edit, so:
 *
 *   serializeCsv(parseCsv(text)) === text        // byte-for-byte, always
 *   editing one cell changes exactly one line    // clean git diffs
 *
 * That matters because these files live in repos that coding agents diff and commit. A save that
 * renormalises quoting or line endings across the whole file would make every edit unreviewable.
 *
 * Terminators are per-ROW, not per-document: a file with mixed line endings (`a\r\n b\n`) is a real
 * thing, and a document-wide `eol` would silently rewrite every line that disagreed with it. It is
 * also why there is no `trailingNewline` flag — a file that does not end in a newline is simply one
 * whose LAST row has `eol === ''`.
 *
 * Hand-rolled rather than a library because a library hands back cells and throws the original
 * bytes away — and the original bytes ARE the feature.
 */

export interface CsvRow {
  cells: string[];
  /** This row's source text, excluding its line terminator. null for a row created in the grid. */
  raw: string | null;
  /** This row's own terminator, verbatim: '\n' | '\r\n' | '\r' | '' (last row, no trailing newline). */
  eol: string;
}

export interface CsvDoc {
  rows: CsvRow[];
  delimiter: string;
  /** Terminator for NEWLY inserted rows — the first one seen in the file, else '\n'. */
  eol: string;
  bom: boolean;
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
 *
 * Quote handling mirrors parseCsv: a quote only OPENS a quoted field when the field is still empty.
 * A mid-field quote (`ab"cd`) is literal data, so treating it as a quote toggle here would skew the
 * count against the parser's own view of the file.
 *
 * The subtlety: while COUNTING we do not yet know which character is the real delimiter, so ANY
 * candidate has to end a field. If only the candidate being counted reset `fieldEmpty`, then a
 * quoted field that does not start in column 0 would be invisible while counting every OTHER
 * candidate — the opening `"` would look like mid-field data, the field would never be entered, and
 * the delimiters INSIDE it would be counted as structure. `id,note\n1,"a; b; c; d"` would then be
 * detected as semicolon-delimited, and the first edit would rewrite the line into garbage.
 */
function countOutsideQuotes(text: string, delim: string): number {
  let n = 0;
  let inQuotes = false;
  let fieldEmpty = true;   // mirrors the parser's `field === ''`

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { i++; fieldEmpty = false; continue; }   // "" is a literal quote
        inQuotes = false;                                                 // closing quote adds nothing
      } else fieldEmpty = false;
      continue;
    }

    if (c === '"' && fieldEmpty) { inQuotes = true; continue; }
    // Any candidate ends a field — see the note above. Only `delim` is tallied.
    if (CANDIDATES.includes(c)) { if (c === delim) n++; fieldEmpty = true; continue; }
    if (c === '\n' || c === '\r') { fieldEmpty = true; continue; }        // row break resets the field
    fieldEmpty = false;
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
  const body = bom ? text.slice(BOM.length) : text;

  const delimiter = detectDelimiter(body, path);

  const rows: CsvRow[] = [];
  let docEol: string | null = null;

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

    // A row break — but only outside quotes; a newline inside quotes is data. A bare '\r' with no
    // '\n' after it is a classic-Mac terminator, NOT field data.
    const term =
      c === '\r' ? (body[i + 1] === '\n' ? '\r\n' : '\r')
      : c === '\n' ? '\n'
      : null;

    if (term !== null) {
      cells.push(field);
      rows.push({ cells, raw: body.slice(rowStart, i), eol: term });
      if (docEol === null) docEol = term;
      cells = []; field = '';
      i += term.length - 1;
      rowStart = i + 1;
      continue;
    }

    field += c;
  }

  if (inQuotes) throw new Error('Malformed CSV: unterminated quoted field');

  // If the scanner finished exactly at the end of the body, the file ENDED with a terminator and
  // every row has already been pushed — there is no phantom trailing row. Only a pending partial
  // row (text after the last terminator) gets flushed, and it has no terminator of its own.
  if (rowStart < body.length) {
    cells.push(field);
    rows.push({ cells, raw: body.slice(rowStart), eol: '' });
  }

  return { rows, delimiter, eol: docEol ?? '\n', bom };
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
  const body = doc.rows.map((r) => serializeRow(r, doc.delimiter) + r.eol).join('');
  return (doc.bom ? BOM : '') + body;
}

/** Setting `raw` to null is what marks a row "rewrite me" — every other row stays byte-identical. */
export function editCell(doc: CsvDoc, row: number, col: number, value: string): CsvDoc {
  const rows = doc.rows.slice();
  const target = rows[row];
  if (!target) return doc;
  const cells = target.cells.slice();
  while (cells.length <= col) cells.push('');   // only widen the row you actually edited
  cells[col] = value;
  rows[row] = { cells, raw: null, eol: target.eol };   // the row's terminator is not ours to change
  return { ...doc, rows };
}

export function insertRow(doc: CsvDoc, at: number): CsvDoc {
  const width = Math.max(1, columnCount(doc));
  const rows = doc.rows.slice();

  let eol = doc.eol;
  const last = rows[rows.length - 1];
  if (at === rows.length && last && last.eol === '') {
    // Appending to a file that does not end in a newline: the old last row now needs a terminator,
    // and the NEW last row inherits the missing one. Its `raw` is untouched — only the eol moves.
    rows[rows.length - 1] = { ...last, eol: doc.eol };
    eol = '';
  }

  rows.splice(at, 0, { cells: Array(width).fill(''), raw: null, eol });
  return { ...doc, rows };
}

export function deleteRow(doc: CsvDoc, at: number): CsvDoc {
  const rows = doc.rows.slice();
  const removed = rows[at];
  if (!removed) return doc;
  const wasLast = at === rows.length - 1;

  rows.splice(at, 1);

  // Deleting the final row of a file with no trailing newline: the row that becomes last inherits
  // the missing terminator, so the file keeps its shape. Only its eol changes; `raw` survives.
  const newLast = rows[rows.length - 1];
  if (wasLast && removed.eol === '' && newLast) {
    rows[rows.length - 1] = { ...newLast, eol: '' };
  }

  return { ...doc, rows };
}
