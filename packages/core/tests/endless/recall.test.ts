import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { EndlessStore } from '../../src/endless/store.js';
import { zoom, dateOf, formatWhen, RecallError } from '../../src/endless/recall.js';
import { PLACEHOLDER } from '../../src/endless/view.js';

function store() {
  const db = new Database(':memory:');
  initSchema(db);
  return new EndlessStore(db);
}

describe('recall', () => {
  it('zoom(id, 1) gives the message whole, with its images', () => {
    const s = store();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'endless-recall-'));
    const img = path.join(dir, 'a.png');
    fs.writeFileSync(img, Buffer.from([1, 2, 3]));
    s.append({ kind: 'user', text: 'look at this\nplease', project: 'p1', media: [img] });
    const r = zoom(s, () => 'salsify', 0, 1);
    expect(r.text).toBe('#0 user (salsify): look at this\nplease');
    expect(r.images).toEqual([{ mimeType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('zoom(id, n) opens a line into the two lines it was made from', () => {
    const s = store();
    for (let k = 0; k < 4; k++) s.append({ kind: 'user', text: `m${k}` });
    s.appendNode(1, 0, 'first half');
    s.appendNode(1, 1, 'second\nhalf');
    expect(zoom(s, () => null, 0, 4).text).toBe('0+2|first half\n2+2|second half');
    expect(zoom(s, () => null, 2, 2).text).toBe(`2+1|${PLACEHOLDER}\n3+1|${PLACEHOLDER}`);
  });

  it('rejects bad names and ranges past the end', () => {
    const s = store();
    s.append({ kind: 'user', text: 'x' });
    expect(() => zoom(s, () => null, 0, 3)).toThrow(RecallError);
    expect(() => zoom(s, () => null, 1, 2)).toThrow(RecallError);
    expect(() => zoom(s, () => null, 0, 2)).toThrow(/not all in the chat/);
  });

  it('date(id) gives the date and time of a message', () => {
    const s = store();
    s.append({ kind: 'user', text: 'x', createdAt: Date.UTC(2026, 9, 13, 14, 5, 9) });
    expect(dateOf(s, 0, 'UTC')).toBe('Tue 2026-10-13 14:05:09 UTC');
    expect(formatWhen(Date.UTC(2026, 0, 1, 0, 0, 0), 'UTC')).toBe('Thu 2026-01-01 00:00:00 UTC');
    expect(() => dateOf(s, 5, 'UTC')).toThrow(RecallError);
  });
});
