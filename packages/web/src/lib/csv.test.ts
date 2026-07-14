import { describe, it, expect } from 'vitest';
import { parseCsv, serializeCsv, editCell, insertRow, deleteRow, columnCount } from './csv';

/** The load-bearing property: parse then serialize must return the input untouched. */
describe('round-trip fidelity', () => {
  const cases: [string, string][] = [
    ['simple', 'a,b,c\n1,2,3\n'],
    ['no trailing newline', 'a,b,c\n1,2,3'],
    ['single row, no trailing newline', 'a,b'],
    ['CRLF', 'a,b,c\r\n1,2,3\r\n'],
    ['BOM', '﻿a,b,c\n1,2,3\n'],
    ['BOM + quoted first row', '﻿"a","b"\n1,2\n'],
    ['quoted field with a comma', 'name,note\n"Smith, John",hi\n'],
    ['escaped quotes', 'a,b\n"He said ""hi""",2\n'],
    ['newline inside a quoted field', 'a,b\n"line1\nline2",2\n'],
    ['CRLF inside a quoted field', 'a,b\r\n"line1\r\nline2",2\r\n'],
    ['ragged rows', 'a,b,c\n1,2\n3,4,5,6\n'],
    ['empty fields', 'a,b,c\n,,\n'],
    ['redundantly quoted fields', '"a","b"\n"1","2"\n'],
    ['quoted field with semicolons, NOT in the first column', 'id,note\n1,"a; b; c; d"\n2,"e; f; g; h"\n'],
    ['semicolons', 'a;b;c\n1;2;3\n'],
    ['tabs', 'a\tb\tc\n1\t2\t3\n'],
    ['empty file', ''],
    ['a lone newline', '\n'],
    ['trailing blank line', 'a,b\n\n'],
    ['header only', 'a,b,c\n'],
    // Mixed line endings — a document-wide eol silently rewrites the odd line out.
    ['mixed EOL, CRLF first', 'a,b\r\n1,2\n3,4\r\n'],
    ['mixed EOL, LF first', 'a,b\n1,2\r\n3,4\n'],
    ['mixed EOL, no trailing newline', 'a,b\r\n1,2\n3,4'],
    // Classic-Mac bare CR is a terminator, not field data.
    ['bare CR', 'a,b\rc,d\r'],
    ['bare CR, no trailing newline', 'a,b\rc,d'],
    ['all three terminators', 'a,b\r1,2\n3,4\r\n5,6'],
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
    expect(d).toMatchObject({ delimiter: ';', eol: '\r\n', bom: true });
    // The file ends in a newline — that is now expressed as the LAST row owning a terminator,
    // not as a document-wide `trailingNewline` flag.
    expect(d.rows.map((r) => r.eol)).toEqual(['\r\n', '\r\n']);
  });

  it('records no trailing newline as an empty eol on the last row', () => {
    const d = parseCsv('a,b\n1,2');
    expect(d.rows.map((r) => r.eol)).toEqual(['\n', '']);
    expect(d.eol).toBe('\n');   // the default for NEW rows is still the first one seen
  });

  it('does not fabricate a phantom trailing row when line endings are mixed', () => {
    // Regression: a single stray CRLF used to make the document-wide eol '\r\n', so the trailing
    // '\n' was not recognised as the terminator, and the post-scan flush pushed an empty 4th row.
    const d = parseCsv('a,b\n1,2\r\n3,4\n');
    expect(d.rows).toHaveLength(3);
    expect(d.rows.map((r) => r.cells)).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  it('captures each row terminator individually', () => {
    const d = parseCsv('a,b\r\n1,2\n3,4\r\n');
    expect(d.rows.map((r) => r.eol)).toEqual(['\r\n', '\n', '\r\n']);
    expect(d.eol).toBe('\r\n');   // doc eol = the FIRST terminator seen
  });

  it('treats a bare CR as a row break, not field data', () => {
    const d = parseCsv('a,b\rc,d\r');
    expect(d.rows).toHaveLength(2);
    expect(d.rows.map((r) => r.cells)).toEqual([['a', 'b'], ['c', 'd']]);
    expect(d.rows.map((r) => r.eol)).toEqual(['\r', '\r']);
  });

  it('counts a trailing blank line as a real empty row', () => {
    const d = parseCsv('a,b\n\n');
    expect(d.rows).toHaveLength(2);
    expect(d.rows[1].cells).toEqual(['']);
  });

  it('yields no rows at all for an empty file', () => {
    expect(parseCsv('').rows).toEqual([]);
  });

  it('is not fooled by a delimiter inside a quoted field in the FIRST column', () => {
    // Four commas but only one real semicolon-free structure: comma must still win.
    const d = parseCsv('a,b\n"x;y;z;w",2\n');
    expect(d.delimiter).toBe(',');
    expect(d.rows[1].cells).toEqual(['x;y;z;w', '2']);
  });

  it('is not fooled by a delimiter inside a quoted field in a LATER column', () => {
    // The first-column case above is the ONE position where a quoted field is trivially visible to
    // the counter (the preceding newline left the field empty). A quoted notes column — a totally
    // ordinary CSV — is the real test: while counting ';' the counter must still see the commas as
    // field ends, or it never enters the quoted field, counts the semicolons inside it as
    // structure, and picks ';'. An edit would then rewrite the line into garbage.
    const text = 'id,note\n1,"a; b; c; d"\n2,"e; f; g; h"\n';
    const d = parseCsv(text);
    expect(d.delimiter).toBe(',');
    expect(d.rows[1].cells).toEqual(['1', 'a; b; c; d']);
    // ...and an edit rewrites only the edited cell, with the data intact. The rewritten note KEEPS
    // its quotes even though it holds no comma: bare, its semicolons would become structure to the
    // next detectDelimiter. See 'an edit never changes what the delimiter looks like' below.
    expect(serializeCsv(editCell(d, 1, 0, 'X'))).toBe('id,note\nX,"a; b; c; d"\n2,"e; f; g; h"\n');
  });

  it('does not let a mid-field quote skew delimiter detection', () => {
    // `ab"cd` — the parser treats that quote as literal data (it only opens a quoted field when the
    // field is empty). Delimiter detection must use the same rule, or it sees the rest of the line
    // as "quoted" and stops counting the real commas.
    const d = parseCsv('x,y,z\nab"cd,1,2\n');
    expect(d.delimiter).toBe(',');
    expect(d.rows[1].cells).toEqual(['ab"cd', '1', '2']);
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
    // Deliberately non-canonical quoting: if serializeRow ever rebuilt a row from its cells instead
    // of re-emitting `raw`, the untouched rows would come back as a,b,c — so this fixture actually
    // pins the property. A plain unquoted fixture would pass even under a whole-file rewrite.
    const text = '"a","b","c"\n"1","2","3"\n"4","5","6"\n';
    const out = serializeCsv(editCell(parseCsv(text), 2, 1, 'X'));
    expect(out).toBe('"a","b","c"\n"1","2","3"\n4,X,6\n');
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

  it('quotes a value holding a RIVAL delimiter, not just the document one', () => {
    // In a comma file, ';' '\t' and '|' are not structure — but they are all CANDIDATES, and
    // detectDelimiter counts them on the next open. Emitted bare, they become structure.
    const d = parseCsv('a,b\n1,2\n');
    expect(serializeCsv(editCell(d, 1, 0, 'has;semi'))).toBe('a,b\n"has;semi",2\n');
    expect(serializeCsv(editCell(d, 1, 0, 'has\ttab'))).toBe('a,b\n"has\ttab",2\n');
    expect(serializeCsv(editCell(d, 1, 0, 'has|pipe'))).toBe('a,b\n"has|pipe",2\n');
    // ...and symmetrically, a comma in a SEMICOLON file.
    const s = parseCsv('a;b\n1;2\n');
    expect(serializeCsv(editCell(s, 1, 0, 'has,comma'))).toBe('a;b\n"has,comma";2\n');
  });

  it('pads a ragged row only when you edit past its end', () => {
    const d = parseCsv('a,b,c\n1,2\n');
    expect(serializeCsv(editCell(d, 1, 2, 'Z'))).toBe('a,b,c\n1,2,Z\n');
  });

  it('uses the document delimiter and eol for the rewritten row', () => {
    const d = parseCsv('a;b\r\n1;2\r\n');
    expect(serializeCsv(editCell(d, 1, 1, 'X'))).toBe('a;b\r\n1;X\r\n');
  });

  it('keeps the edited row on its own terminator in a mixed-EOL file', () => {
    // Row 1 ends with '\n' even though the document's first terminator is '\r\n'. Rewriting it must
    // not drag it onto the document-wide style.
    const d = parseCsv('a,b\r\n1,2\n3,4\r\n');
    expect(serializeCsv(editCell(d, 1, 1, 'X'))).toBe('a,b\r\n1,X\n3,4\r\n');
  });

  it('keeps a file without a trailing newline without one after an edit', () => {
    const d = parseCsv('a,b\n1,2');
    expect(serializeCsv(editCell(d, 1, 1, 'X'))).toBe('a,b\n1,X');
  });
});

/**
 * The invariant that makes the feature safe: an edit must be a FIXED POINT of save/reopen.
 *
 *   parseCsv(serializeCsv(edit(d))).delimiter === d.delimiter
 *
 * parseCsv re-detects the delimiter from scratch every time, so a rewritten row that drops quotes
 * around a value containing a rival delimiter changes what the FILE looks like to the detector. The
 * save itself looks perfect (one-line diff, identical cells); the damage lands on the NEXT open,
 * when the file is reinterpreted under a different delimiter — and the edit after that writes the
 * garbage to disk. These tests open the file again, which is the only way to see it.
 */
describe('an edit never changes what the delimiter looks like', () => {
  it('survives the semicolon-notes save/reopen cycle', () => {
    // The exact corruption path. Serializing alone looks fine — you have to RE-PARSE to catch it.
    const original = 'id,note\n1,"a; b; c; d"\n';
    const doc = parseCsv(original);
    expect(doc.delimiter).toBe(',');
    expect(doc.rows[1].cells).toEqual(['1', 'a; b; c; d']);

    const saved = serializeCsv(editCell(doc, 1, 0, 'X'));

    // REOPEN what we just wrote — this is the step that used to reinterpret the whole file.
    const reopened = parseCsv(saved);
    expect(reopened.delimiter).toBe(',');                            // NOT ';'
    expect(reopened.rows[0].cells).toEqual(['id', 'note']);          // NOT ['id,note']
    expect(reopened.rows[1].cells).toEqual(['X', 'a; b; c; d']);     // the note is still ONE cell

    // A second edit-and-save is therefore stable, rather than destroying the file.
    const saved2 = serializeCsv(editCell(reopened, 1, 0, 'Y'));
    expect(saved2).toBe('id,note\nY,"a; b; c; d"\n');
    expect(parseCsv(saved2).delimiter).toBe(',');
  });

  const cases: [name: string, text: string, row: number, col: number, value: string][] = [
    ['semicolons in a quoted note (comma file)', 'id,note\n1,"a; b; c; d"\n', 1, 0, 'X'],
    ['tabs in a quoted value (comma file)', 'id,note\n1,"a\tb\tc\td"\n', 1, 0, 'X'],
    ['pipes in a quoted value (comma file)', 'id,note\n1,"a|b|c|d"\n', 1, 0, 'X'],
    ['commas in a quoted value (semicolon file)', 'id;note\n1;"a, b, c, d"\n', 1, 0, 'X'],
    ['commas in a quoted value (tab file)', 'id\tnote\n1\t"a, b, c, d"\n', 1, 0, 'X'],
    ['semicolons in a quoted value (pipe file)', 'id|note\n1|"a; b; c; d"\n', 1, 0, 'X'],
    // Editing the cell that HOLDS the rival delimiters — the new value must be quoted too.
    ['a rival delimiter typed INTO the edited cell', 'id,note\n1,ok\n', 1, 1, 'p; q; r; s'],
    // ...and the ordinary case must not regress into over-quoting.
    ['a plain edit stays plain', 'a,b,c\n1,2,3\n4,5,6\n', 1, 1, 'X'],
    ['a plain edit in a CRLF file', 'a,b\r\n1,2\r\n', 1, 1, 'X'],
  ];

  it.each(cases)('%s', (_name, text, row, col, value) => {
    const doc = parseCsv(text);
    const edited = editCell(doc, row, col, value);
    const reopened = parseCsv(serializeCsv(edited));

    // 1. The file still describes itself the same way.
    expect(reopened.delimiter).toBe(doc.delimiter);

    // 2. Every row's cells survive the save/reopen unchanged — including the edited one, whose
    //    cells are exactly the pre-serialization cells. Nothing was split, merged, or re-quoted
    //    into a different meaning.
    expect(reopened.rows.map((r) => r.cells)).toEqual(edited.rows.map((r) => r.cells));

    // 3. Only the edited cell differs from the original document.
    expect(reopened.rows.map((r) => r.cells)).toEqual(
      doc.rows.map((r, i) =>
        i === row ? r.cells.map((c, j) => (j === col ? value : c)) : r.cells,
      ),
    );
  });

  it('stays a fixed point under repeated edit/save/reopen rounds', () => {
    // Corruption was progressive: save 1 looked clean, the reopen mis-parsed, save 2 wrote garbage.
    // So iterate the whole cycle. Two rows on purpose — that is the ratio that actually flips the
    // detector (2 commas vs 3 semicolons). Adding a third, still-quoted row would tie the counts at
    // 3-3, and detectDelimiter's strict `>` would keep ',' by luck, masking the bug.
    let text = 'id,note\n1,"a; b; c; d"\n';
    for (let i = 0; i < 5; i++) {
      const doc = parseCsv(text);
      expect(doc.delimiter).toBe(',');
      expect(doc.rows[1].cells).toEqual([String(i === 0 ? 1 : i - 1), 'a; b; c; d']);
      text = serializeCsv(editCell(doc, 1, 0, String(i)));
    }
    expect(text).toBe('id,note\n4,"a; b; c; d"\n');
    expect(parseCsv(text).rows.map((r) => r.cells)).toEqual([
      ['id', 'note'],
      ['4', 'a; b; c; d'],
    ]);
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

  it('appending to a file with no trailing newline keeps it without one', () => {
    const doc = insertRow(parseCsv('a,b\n1,2'), 2);
    expect(serializeCsv(doc)).toBe('a,b\n1,2\n,');
    expect(doc.rows.map((r) => r.eol)).toEqual(['\n', '\n', '']);
    expect(doc.rows[1].raw).toBe('1,2');   // the old last row got a terminator, NOT a rewrite
  });

  it('appending to a file that does end in a newline keeps the trailing newline', () => {
    expect(serializeCsv(insertRow(parseCsv('a,b\n1,2\n'), 2))).toBe('a,b\n1,2\n,\n');
  });

  it('gives a newly inserted row the document eol style', () => {
    expect(serializeCsv(insertRow(parseCsv('a,b\r\n1,2\r\n'), 1))).toBe('a,b\r\n,\r\n1,2\r\n');
  });

  it('deleting the last row of a file with no trailing newline keeps it without one', () => {
    const doc = deleteRow(parseCsv('a,b\n1,2\n3,4'), 2);
    expect(serializeCsv(doc)).toBe('a,b\n1,2');
    expect(doc.rows.map((r) => r.eol)).toEqual(['\n', '']);
    expect(doc.rows[1].raw).toBe('1,2');   // the surviving row keeps its verbatim text
  });

  it('deleting a non-last row of a file with no trailing newline leaves the shape alone', () => {
    expect(serializeCsv(deleteRow(parseCsv('a,b\n1,2\n3,4'), 1))).toBe('a,b\n3,4');
  });

  it('deleting the last row of a mixed-EOL file leaves the survivors on their own terminators', () => {
    expect(serializeCsv(deleteRow(parseCsv('a,b\r\n1,2\n3,4\r\n'), 2))).toBe('a,b\r\n1,2\n');
  });
});
