import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { MessageJournal, JournalDuplicateKeyError, MAX_PAYLOAD_CHARS } from './journal.js';

function open() {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}
const user = (text: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });

describe('MessageJournal', () => {
  it('append gives 1, 2, 3 per thread', () => {
    const j = new MessageJournal(open());
    expect([1, 2, 3].map((n) => j.append('a', { kind: 'user', payload: user(`m${n}`) }))).toEqual([1, 2, 3]);
    expect(j.lastSeq('a')).toBe(3);
  });

  it('two threads have independent sequences', () => {
    const j = new MessageJournal(open());
    expect(j.append('a', { kind: 'user', payload: user('1') })).toBe(1);
    expect(j.append('b', { kind: 'user', payload: user('1') })).toBe(1);
    expect(j.append('a', { kind: 'user', payload: user('2') })).toBe(2);
    expect(j.append('b', { kind: 'user', payload: user('2') })).toBe(2);
    expect(j.lastSeq('a')).toBe(2);
    expect(j.lastSeq('none')).toBe(0);
  });

  it('the same native id updates in place', () => {
    const j = new MessageJournal(open());
    j.append('a', { kind: 'user', payload: user('first') });
    const seq = j.append('a', { kind: 'tool', nativeId: 'tu:1', payload: { input: {} } });
    j.append('a', { kind: 'user', payload: user('after') });
    expect(j.append('a', { kind: 'tool', nativeId: 'tu:1', payload: { input: { command: 'ls' } } })).toBe(seq);
    const page = j.page('a');
    expect(page.items.map((i) => i.seq)).toEqual([1, 2, 3]);
    expect(page.items[1].payload).toEqual({ input: { command: 'ls' } });
    expect(j.lastSeq('a')).toBe(3);
    // The same native id in another thread is another item.
    expect(j.append('b', { kind: 'tool', nativeId: 'tu:1', payload: {} })).toBe(1);
  });

  it('page before and after return the right windows', () => {
    const j = new MessageJournal(open());
    for (let n = 1; n <= 10; n++) j.append('a', { kind: 'user', payload: user(`m${n}`) });
    const newest = j.page('a', { limit: 3 });
    expect(newest.items.map((i) => i.seq)).toEqual([8, 9, 10]);
    expect(newest).toMatchObject({ firstSeq: 1, lastSeq: 10, hasMore: true });
    const older = j.page('a', { beforeSeq: 8, limit: 3 });
    expect(older.items.map((i) => i.seq)).toEqual([5, 6, 7]);
    expect(older.hasMore).toBe(true);
    const oldest = j.page('a', { beforeSeq: 3, limit: 5 });
    expect(oldest.items.map((i) => i.seq)).toEqual([1, 2]);
    expect(oldest.hasMore).toBe(false);
    const after = j.page('a', { afterSeq: 7, limit: 2 });
    expect(after.items.map((i) => i.seq)).toEqual([8, 9]);
    expect(after.hasMore).toBe(true);
    const rest = j.page('a', { afterSeq: 9 });
    expect(rest.items.map((i) => i.seq)).toEqual([10]);
    expect(rest.hasMore).toBe(false);
    expect(j.page('a', { afterSeq: 10 }).items).toEqual([]);
    expect(j.page('none')).toEqual({ items: [], firstSeq: 0, lastSeq: 0, hasMore: false });
  });

  it('a payload over the limit is cut and flagged', () => {
    const j = new MessageJournal(open());
    const big = 'x'.repeat(MAX_PAYLOAD_CHARS + 5000);
    j.append('a', { kind: 'tool', payload: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: big }, { type: 'text', text: 'kept' }] } } });
    j.append('a', { kind: 'user', payload: user('small') });
    const [cut, small] = j.page('a').items;
    expect(cut.truncated).toBe(true);
    expect(JSON.stringify(cut.payload).length).toBeLessThanOrEqual(MAX_PAYLOAD_CHARS);
    const blocks = (cut.payload as any).message.content;
    expect(blocks[0].content.length).toBeLessThan(big.length);
    expect(blocks[0].tool_use_id).toBe('t');
    expect(blocks[1].text).toBe('kept'); // a short string is not cut
    expect(small.truncated).toBe(false);
  });

  // Final review of v4.5.0, I2: an image over about 190 KB made its payload pass the limit, the cut
  // replaced its source with { type: 'cut' }, and the client showed nothing after a reopen.
  describe('an image in a payload over the limit', () => {
    /** `bytes` of data that does not compress or repeat, as base64. */
    const picture = (bytes: number, seed = 1) => { const b = Buffer.alloc(bytes); for (let i = 0; i < bytes; i++) b[i] = (i * 31 + seed * 17 + (i >> 8)) & 0xff; return b; };
    const withImage = (data: Buffer, media_type = 'image/png') => ({
      type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image', source: { type: 'base64', media_type, data: data.toString('base64') } }] },
    });
    const sourceOf = (item: { payload: unknown }) => (item.payload as any).message.content[1].source;

    it('keeps the image: the row has a reference, the image store has the bytes once', () => {
      const j = new MessageJournal(open());
      const data = picture(300 * 1024);
      j.append('a', { kind: 'user', payload: withImage(data) });
      const [item] = j.page('a').items;
      expect(item.truncated).toBe(false); // nothing was lost
      const source = sourceOf(item);
      expect(source).toEqual({ type: 'journal_image', id: expect.stringMatching(/^[0-9a-f]{64}$/), media_type: 'image/png', thread: 'a' });
      expect((item.payload as any).message.content[0].text).toBe('look at this');
      expect(JSON.stringify(item.payload).length).toBeLessThan(1000);
      const stored = j.image('a', source.id)!;
      expect(stored.mediaType).toBe('image/png');
      expect(stored.data.equals(data)).toBe(true);
      // The same picture again (a second message, a second thread) is its own reference to one stored copy per thread.
      j.append('a', { kind: 'user', payload: withImage(data) });
      expect(sourceOf(j.page('a').items[1]).id).toBe(source.id);
      expect(j.imageStats('a')).toEqual({ images: 1, bytes: data.length });
      expect(j.image('b', source.id)).toBeNull(); // an image belongs to its thread
    });

    it('a small image in a small payload stays in the payload', () => {
      const j = new MessageJournal(open());
      const data = picture(20 * 1024);
      j.append('a', { kind: 'user', payload: withImage(data) });
      expect(sourceOf(j.page('a').items[0])).toEqual({ type: 'base64', media_type: 'image/png', data: data.toString('base64') });
      expect(j.imageStats('a')).toEqual({ images: 0, bytes: 0 });
    });

    it('an image in a tool result is kept too, and long text next to it is still cut', () => {
      const j = new MessageJournal(open());
      const data = picture(250 * 1024, 2);
      const big = 'x'.repeat(MAX_PAYLOAD_CHARS + 5000);
      j.append('a', { kind: 'tool', payload: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: big }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: data.toString('base64') } }] }] } } });
      const [item] = j.page('a').items;
      const blocks = (item.payload as any).message.content[0].content;
      expect(item.truncated).toBe(true); // the text was cut
      expect(blocks[0].text.length).toBeLessThan(big.length);
      expect(blocks[1].source.type).toBe('journal_image');
      expect(j.image('a', blocks[1].source.id)!.data.equals(data)).toBe(true);
    });

    it('an image over the image bound is not kept: the source says so, and the item is flagged', () => {
      const j = new MessageJournal(open(), { maxImageChars: 100_000 });
      j.append('a', { kind: 'user', payload: withImage(picture(300 * 1024)) });
      const [item] = j.page('a').items;
      expect(sourceOf(item)).toEqual({ type: 'cut', media_type: 'image/png' });
      expect(item.truncated).toBe(true);
      expect(j.imageStats('a').images).toBe(0);
    });

    it('data that is not a picture type is never stored for the image route', () => {
      const j = new MessageJournal(open());
      j.append('a', { kind: 'user', payload: withImage(picture(300 * 1024), 'text/html') });
      expect(sourceOf(j.page('a').items[0]).type).toBe('cut');
      expect(j.imageStats('a').images).toBe(0);
    });

    it('the images of a thread stay under the image bound, the oldest go first; another thread is not touched', () => {
      const j = new MessageJournal(open(), { maxThreadImageBytes: 1_000_000 });
      j.append('b', { kind: 'user', payload: withImage(picture(300 * 1024, 99)) });
      for (let n = 1; n <= 8; n++) j.append('a', { kind: 'user', payload: withImage(picture(300 * 1024, n)) });
      expect(j.imageStats('a').bytes).toBeLessThanOrEqual(1_000_000);
      expect(j.imageStats('a').images).toBeGreaterThanOrEqual(2);
      const items = j.page('a').items;
      expect(j.image('a', sourceOf(items[7]).id)).not.toBeNull(); // the newest image is there
      expect(j.image('a', sourceOf(items[0]).id)).toBeNull();     // the oldest is gone; its row stays
      expect(j.imageStats('b').images).toBe(1);
    });

    it('an image goes with the trim of its row, and with its thread', () => {
      const db = open();
      const now = new Date().toISOString();
      db.prepare("INSERT INTO sessions (id, provider, name, working_dir, created_at, updated_at, last_activity_at) VALUES ('s','claude-code','s','/tmp',?,?,?)").run(now, now, now);
      for (const id of ['a', 'b', 'c']) db.prepare("INSERT INTO terminals (id, session_id, type, label, created_at) VALUES (?, 's', 'grok', 'x', ?)").run(id, now);
      const j = new MessageJournal(db, { maxThreadRows: 10 });
      for (const id of ['a', 'b', 'c']) j.append(id, { kind: 'user', payload: withImage(picture(300 * 1024)) });
      for (let n = 0; n < 30; n++) j.append('a', { kind: 'user', payload: user(`m${n}`) });
      expect(j.page('a', { limit: 500 }).firstSeq).toBeGreaterThan(1); // the row of the image was trimmed
      expect(j.imageStats('a').images).toBe(0);
      j.removeThread('b');
      expect(j.imageStats('b').images).toBe(0);
      db.prepare("DELETE FROM terminals WHERE id = 'c'").run();
      expect(j.imageStats('c').images).toBe(0);
    });
  });

  it('a repeated idempotency key is refused', () => {
    const j = new MessageJournal(open());
    const seq = j.append('a', { kind: 'user', payload: user('once'), idemKey: 'k1' });
    let error: unknown;
    try { j.append('a', { kind: 'user', payload: user('twice'), idemKey: 'k1' }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(JournalDuplicateKeyError);
    expect((error as JournalDuplicateKeyError).seq).toBe(seq);
    expect(j.lastSeq('a')).toBe(1);
    // Another thread may use the same key.
    expect(j.append('b', { kind: 'user', payload: user('once'), idemKey: 'k1' })).toBe(1);
    expect(j.findKey('a', 'k1')).toMatchObject({ seq, kind: 'user' });
    expect(j.findKey('a', 'k2')).toBeNull();
  });

  it('a key is kept on an item that exists already, and refused the second time', () => {
    const j = new MessageJournal(open());
    j.append('a', { kind: 'user', payload: user('hi') });
    expect(j.setKey('a', 1, 'k1')).toBe(true);
    expect(j.findKey('a', 'k1')?.seq).toBe(1);
    j.append('a', { kind: 'user', payload: user('hi again') });
    expect(j.setKey('a', 2, 'k1')).toBe(false);
  });

  it('a sequence never repeats or goes back, across instances and after a trim', () => {
    const db = open();
    const j = new MessageJournal(db, { maxThreadRows: 10 });
    const seen: number[] = [];
    for (let n = 0; n < 35; n++) seen.push(j.append('a', { kind: 'user', payload: user(`m${n}`) }));
    const again = new MessageJournal(db, { maxThreadRows: 10 }); // a new daemon on the same database
    for (let n = 0; n < 5; n++) seen.push(again.append('a', { kind: 'user', payload: user(`n${n}`) }));
    expect(seen).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(new Set(seen).size).toBe(40);
  });

  it('the rows of a thread stay under the row bound, oldest removed first', () => {
    const j = new MessageJournal(open(), { maxThreadRows: 20 });
    for (let n = 1; n <= 100; n++) j.append('a', { kind: 'user', payload: user(`m${n}`) });
    const s = j.stats('a');
    expect(s.rows).toBeLessThanOrEqual(20);
    expect(s.rows).toBeGreaterThanOrEqual(10);
    const page = j.page('a', { limit: 500 });
    expect(page.lastSeq).toBe(100);
    expect(page.items[page.items.length - 1].seq).toBe(100);
    expect(page.firstSeq).toBe(page.items[0].seq);
    expect(page.firstSeq).toBeGreaterThan(1);
    expect(page.hasMore).toBe(false);
  });

  it('the bytes of a thread stay under the size bound, and another thread is not touched', () => {
    const j = new MessageJournal(open(), { maxThreadBytes: 50_000 });
    for (let n = 1; n <= 5; n++) j.append('b', { kind: 'user', payload: user('keep') });
    for (let n = 1; n <= 200; n++) j.append('a', { kind: 'assistant', payload: { type: 'assistant', message: { content: [{ type: 'text', text: 'y'.repeat(1000) }] } } });
    expect(j.stats('a').bytes).toBeLessThanOrEqual(50_000);
    expect(j.stats('a').rows).toBeGreaterThan(10);
    expect(j.stats('b').rows).toBe(5);
    expect(j.page('a').lastSeq).toBe(200);
  });

  it('removeThread removes the rows of one thread only', () => {
    const j = new MessageJournal(open());
    j.append('a', { kind: 'user', payload: user('1') });
    j.append('b', { kind: 'user', payload: user('1') });
    j.removeThread('a');
    expect(j.lastSeq('a')).toBe(0);
    expect(j.lastSeq('b')).toBe(1);
  });

  it('a deleted thread loses its rows; an archived thread keeps them', () => {
    const db = open();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO sessions (id, provider, name, working_dir, created_at, updated_at, last_activity_at) VALUES ('s','claude-code','s','/tmp',?,?,?)").run(now, now, now);
    for (const id of ['t1', 't2']) db.prepare("INSERT INTO terminals (id, session_id, type, label, created_at) VALUES (?, 's', 'grok', 'x', ?)").run(id, now);
    const j = new MessageJournal(db);
    j.append('t1', { kind: 'user', payload: user('1') });
    j.append('t2', { kind: 'user', payload: user('1') });
    db.prepare("UPDATE terminals SET archived_at = ? WHERE id = 't1'").run(now);
    expect(j.lastSeq('t1')).toBe(1);
    db.prepare("DELETE FROM terminals WHERE id = 't1'").run();
    expect(j.lastSeq('t1')).toBe(0);
    expect(j.lastSeq('t2')).toBe(1);
  });

  it('an import mark is for one session of one thread, and goes with a deleted thread', () => {
    const db = open();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO sessions (id, provider, name, working_dir, created_at, updated_at, last_activity_at) VALUES ('s','claude-code','s','/tmp',?,?,?)").run(now, now, now);
    for (const id of ['t1', 't2']) db.prepare("INSERT INTO terminals (id, session_id, type, label, created_at) VALUES (?, 's', 'grok', 'x', ?)").run(id, now);
    const j = new MessageJournal(db);
    expect(j.hasImport('t1', 'sess-a')).toBe(false);
    j.markImported('t1', 'sess-a');
    j.markImported('t1', 'sess-a'); // a second mark changes nothing
    j.markImported('t2', 'sess-a');
    expect(j.hasImport('t1', 'sess-a')).toBe(true);
    expect(j.hasImport('t1', 'sess-b')).toBe(false);
    expect(new MessageJournal(db).hasImport('t1', 'sess-a')).toBe(true); // it is in the database, not in memory
    db.prepare("DELETE FROM terminals WHERE id = 't1'").run();
    expect(j.hasImport('t1', 'sess-a')).toBe(false);
    expect(j.hasImport('t2', 'sess-a')).toBe(true);
  });

  it('a page does not go below a gap mark', () => {
    const j = new MessageJournal(open());
    for (let n = 1; n <= 3; n++) j.append('a', { kind: 'user', payload: user(`old${n}`) });
    j.markGap('a');
    for (let n = 1; n <= 3; n++) j.append('a', { kind: 'user', payload: user(`new${n}`) });
    const page = j.page('a');
    expect(page.items.map((i) => i.seq)).toEqual([5, 6, 7]);
    expect(page).toMatchObject({ firstSeq: 5, lastSeq: 7, hasMore: false });
    expect(j.page('a', { beforeSeq: 5 }).items).toEqual([]);
  });
});
