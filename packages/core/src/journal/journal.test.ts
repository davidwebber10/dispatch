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
