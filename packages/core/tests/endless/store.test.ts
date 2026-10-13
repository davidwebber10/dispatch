import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { EndlessStore, ftsQuery, SNIPPET_OPEN, SNIPPET_CLOSE } from '../../src/endless/store.js';

let db: Database.Database;
let store: EndlessStore;
beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  store = new EndlessStore(db);
});

describe('EndlessStore', () => {
  it('appends dense ids from 0 and reads them back', () => {
    const a = store.append({ kind: 'user', text: 'hello', project: 'p1' });
    const b = store.append({ kind: 'unii', text: 'hi' });
    expect([a.i, b.i]).toEqual([0, 1]);
    expect(store.count()).toBe(2);
    expect(store.get(0)).toMatchObject({ i: 0, kind: 'user', text: 'hello', project: 'p1', ref: null, media: [] });
  });

  it('size is UTF-8 bytes', () => {
    expect(store.append({ kind: 'user', text: 'héllo 😀' }).size).toBe(11);
    expect(store.get(0)!.size).toBe(11);
  });

  it('keeps the media column as a JSON list', () => {
    store.append({ kind: 'user', text: 'see', media: ['/m/a.png', '/m/b.jpg'] });
    expect(store.get(0)!.media).toEqual(['/m/a.png', '/m/b.jpg']);
  });

  it('is append-only: messages and nodes can never be updated or deleted', () => {
    store.append({ kind: 'user', text: 'x' });
    store.appendNode(0, 0, 'user: x');
    expect(() => db.prepare("UPDATE endless_messages SET text = 'y' WHERE i = 0").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM endless_messages WHERE i = 0').run()).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE endless_nodes SET text = 'y'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM endless_nodes').run()).toThrow(/append-only/);
    expect(() => store.appendNode(0, 0, 'again')).toThrow();
  });

  it('pages history backward with a project filter', () => {
    for (let k = 0; k < 10; k++) store.append({ kind: 'user', text: `m${k}`, project: k % 2 ? 'odd' : 'even' });
    const tail = store.page({ limit: 3 });
    expect(tail.messages.map((m) => m.i)).toEqual([7, 8, 9]);
    expect(tail.hasMore).toBe(true);
    expect(store.page({ before: 7, limit: 3 }).messages.map((m) => m.i)).toEqual([4, 5, 6]);
    expect(store.page({ limit: 3, project: 'odd' }).messages.map((m) => m.i)).toEqual([5, 7, 9]);
    expect(store.page({ before: 2, limit: 5 })).toMatchObject({ hasMore: false });
  });

  it('opens a window around a message', () => {
    for (let k = 0; k < 20; k++) store.append({ kind: 'user', text: `m${k}` });
    const w = store.around(10, 6);
    expect(w.messages.map((m) => m.i)).toEqual([8, 9, 10, 11, 12, 13]);
    expect(w.hasMore).toBe(true);
    expect(w.hasMoreAfter).toBe(true);
  });

  it('finds the last run of user messages for a retry', () => {
    store.append({ kind: 'unii', text: 'a' });
    store.append({ kind: 'user', text: 'part 1' });
    store.append({ kind: 'user', text: 'part 2' });
    store.append({ kind: 'tool', text: 'Bash {}' });
    expect(store.lastUserRun().map((m) => m.text)).toEqual(['part 1', 'part 2']);
  });

  it('the view round-trips through a restart unchanged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'endless-store-'));
    const file = path.join(dir, 'd.db');
    const d1 = new Database(file);
    initSchema(d1);
    const s1 = new EndlessStore(d1);
    s1.saveChatView({ lines: [[2, 0], [1, 2], [0, 6]], batching: true });
    s1.saveCompactionView([[2, 0], [1, 3]]);
    d1.close();
    const d2 = new Database(file);
    initSchema(d2);
    const s2 = new EndlessStore(d2);
    expect(s2.loadChatView()).toEqual({ lines: [[2, 0], [1, 2], [0, 6]], batching: true });
    expect(s2.loadCompactionView()).toEqual([[2, 0], [1, 3]]);
    d2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('FTS finds a logged word, filters by project, and marks the snippet', () => {
    store.append({ kind: 'user', text: 'deploy the salsify connector tonight', project: 'p1' });
    store.append({ kind: 'unii', text: 'the connector is deployed', project: 'p2' });
    store.append({ kind: 'user', text: 'unrelated' });
    const hits = store.search('connector');
    expect(hits.map((h) => h.i)).toEqual([1, 0]);
    expect(hits[1].snippet).toContain(`${SNIPPET_OPEN}connector${SNIPPET_CLOSE}`);
    expect(store.search('connector', { project: 'p1' }).map((h) => h.i)).toEqual([0]);
    expect(store.search('   ')).toEqual([]);
    expect(store.search('"quotes" and (parens)')).toEqual([]);
  });

  it('builds safe FTS queries', () => {
    expect(ftsQuery('a "b"')).toBe('"a"* """b"""*');
    expect(ftsQuery('  ')).toBeNull();
  });

  it('lists unbuilt messages and ready merges for boot recovery', () => {
    for (let k = 0; k < 6; k++) store.append({ kind: 'user', text: `m${k}` });
    for (const k of [0, 1, 2, 3, 5]) store.appendNode(0, k, `n${k}`);
    store.appendNode(1, 0, 'n0 n1');
    expect(store.unbuiltMessages()).toEqual([4]);
    expect(store.readyMerges()).toEqual([{ l: 1, i: 1 }]);
  });

  it('counts messages per project and finds the last of a kind', () => {
    store.append({ kind: 'work', text: '[A] report: one', project: 'p1' });
    store.append({ kind: 'work', text: '[B] report: two', project: 'p1' });
    store.append({ kind: 'user', text: 'x', project: 'p2' });
    expect(store.projectCounts()).toEqual({ p1: 2, p2: 1 });
    expect(store.lastOfKind('work', 'p1')!.text).toBe('[B] report: two');
    expect(store.lastOfKind('work', 'p2')).toBeNull();
  });

  it('state keys upsert', () => {
    expect(store.getState('imported')).toBeNull();
    store.setState('imported', '1');
    store.setState('imported', '2');
    expect(store.getState('imported')).toBe('2');
  });

  it('arms, claims once, and lists pending reports', () => {
    store.armReport('t1', 10);
    store.armReport('t2', 5);
    store.armReport('t1', 20); // re-arming keeps one row
    expect(store.pendingReports()).toEqual(['t2', 't1']);
    expect(store.hasPendingReport('t1')).toBe(true);
    expect(store.claimReport('t1')).toBe(true);
    expect(store.claimReport('t1')).toBe(false);
    expect(store.hasPendingReport('t1')).toBe(false);
    expect(store.pendingReports()).toEqual(['t2']);
  });

  it('pending reports survive a restart', () => {
    store.armReport('t1', 1);
    expect(new EndlessStore(db).pendingReports()).toEqual(['t1']);
  });
});
