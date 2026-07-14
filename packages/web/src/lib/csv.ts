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
