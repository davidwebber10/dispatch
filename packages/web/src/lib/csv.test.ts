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
