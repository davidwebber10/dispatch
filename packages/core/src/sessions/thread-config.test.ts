import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { ThreadConfigStore, pickClientSettable, CLIENT_SETTABLE_KEYS } from './thread-config.js';

// W2-A: the one writer of a thread's config column. Every write is a patch of named keys, made
// from a fresh read inside one SQLite transaction, so a writer cannot drop another writer's key.
let db: Database.Database;
let store: ThreadConfigStore;

const raw = (id = 't1'): Record<string, unknown> => JSON.parse(terminalsDb.getById(db, id)!.config as string);
const setRaw = (text: string, id = 't1') => db.prepare('UPDATE terminals SET config = ? WHERE id = ?').run(text, id);

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 'S', provider: 'claude-code', name: 's', workingDir: '/tmp' });
  terminalsDb.create(db, { id: 't1', sessionId: 'S', type: 'claude-code', label: 't', config: { transport: 'structured', role: 'agent', model: 'opus' } });
  store = new ThreadConfigStore(db);
});

afterEach(() => { vi.restoreAllMocks(); });

describe('ThreadConfigStore', () => {
  it('patch changes only the named keys', () => {
    const next = store.patch('t1', { effort: 'high' });
    expect(next).toEqual({ transport: 'structured', role: 'agent', model: 'opus', effort: 'high' });
    expect(raw()).toEqual({ transport: 'structured', role: 'agent', model: 'opus', effort: 'high' });
  });

  it('a null value deletes the key', () => {
    store.patch('t1', { model: null });
    expect(raw()).toEqual({ transport: 'structured', role: 'agent' });
    expect('model' in raw()).toBe(false);
  });

  it('an undefined value deletes the key too', () => {
    store.patch('t1', { model: undefined, effort: 'low' });
    expect(raw()).toEqual({ transport: 'structured', role: 'agent', effort: 'low' });
  });

  it('an unknown key in the row survives a patch', () => {
    setRaw(JSON.stringify({ model: 'opus', pluginThing: { a: [1, 2] }, futureKey: 7 }));
    store.patch('t1', { model: 'sonnet' });
    expect(raw()).toEqual({ model: 'sonnet', pluginThing: { a: [1, 2] }, futureKey: 7 });
    expect(store.read('t1').futureKey).toBe(7);
  });

  it('two patches from two stale copies both land', () => {
    // The lost-update case: two writers read, then each changes its own key.
    const a = store.read('t1');
    const b = store.read('t1');
    expect(a.effort).toBeUndefined();
    expect(b.scheduledWake).toBeUndefined();
    store.patch('t1', { effort: 'high' });            // writer A, from its stale copy
    store.patch('t1', { scheduledWake: 'at noon' });  // writer B, from its stale copy
    expect(raw()).toMatchObject({ effort: 'high', scheduledWake: 'at noon', model: 'opus', role: 'agent', transport: 'structured' });
  });

  it('a copy returned by read is not the stored value: a change to it writes nothing', () => {
    const copy = store.read('t1');
    (copy as Record<string, unknown>).model = 'changed-in-memory';
    expect(store.read('t1').model).toBe('opus');
  });

  it('a function patch sees the value written by an earlier patch in the same tick', () => {
    store.patch('t1', { kickedAt: 'first' });
    let seen: unknown;
    store.patch('t1', (current) => { seen = current.kickedAt; return { interruptedAt: `${current.kickedAt}-then` }; });
    expect(seen).toBe('first');
    expect(raw()).toMatchObject({ kickedAt: 'first', interruptedAt: 'first-then' });
  });

  it('a function patch that returns null writes nothing', () => {
    const before = terminalsDb.getById(db, 't1')!.config;
    const changes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const n = changes();
    const out = store.patch('t1', () => null);
    expect(out).toEqual({ transport: 'structured', role: 'agent', model: 'opus' });
    expect(changes()).toBe(n);
    expect(terminalsDb.getById(db, 't1')!.config).toBe(before);
  });

  it('transaction applies several patches as one write and returns the callback value', () => {
    const out = store.transaction('t1', (tx) => {
      tx.patch({ effort: 'high' });
      expect(tx.get().effort).toBe('high');
      tx.patch({ model: null, accountId: 'acct-1' });
      return tx.get().accountId;
    });
    expect(out).toBe('acct-1');
    expect(raw()).toEqual({ transport: 'structured', role: 'agent', effort: 'high', accountId: 'acct-1' });
  });

  it('transaction rolls back every change when the callback throws', () => {
    expect(() => store.transaction('t1', (tx) => {
      tx.patch({ effort: 'high' });
      // A second row changed in the same transaction is rolled back with it.
      db.prepare("UPDATE terminals SET label = 'changed' WHERE id = 't1'").run();
      tx.patch({ model: 'sonnet' });
      throw new Error('boom');
    })).toThrow('boom');
    expect(raw()).toEqual({ transport: 'structured', role: 'agent', model: 'opus' });
    expect(terminalsDb.getById(db, 't1')!.label).toBe('t');
  });

  it('bad JSON reads as an empty config and does not throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setRaw('{not json');
    expect(store.read('t1')).toEqual({});
    expect(store.read('t1')).toEqual({});
    // Logged once for the thread, not on every read.
    expect(warn).toHaveBeenCalledTimes(1);
    // A patch on a bad row starts from the empty config.
    store.patch('t1', { model: 'opus' });
    expect(raw()).toEqual({ model: 'opus' });
  });

  it('a row whose config is not an object reads as an empty config', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const text of ['[1,2]', '"text"', '5', 'null']) {
      setRaw(text);
      expect(store.read('t1')).toEqual({});
    }
  });

  it('a missing thread reads as an empty config and a patch on it writes nothing', () => {
    expect(store.read('nope')).toEqual({});
    expect(store.patch('nope', { model: 'opus' })).toEqual({});
    expect(terminalsDb.getById(db, 'nope')).toBeNull();
  });

  it('initialize writes the whole config of a new thread', () => {
    terminalsDb.create(db, { id: 't2', sessionId: 'S', type: 'claude-code', label: 'n' });
    store.initialize('t2', { role: 'coordinator', transport: 'structured' });
    expect(raw('t2')).toEqual({ role: 'coordinator', transport: 'structured' });
  });

  it('a patch inside an open transaction joins it and rolls back with it', () => {
    expect(() => db.transaction(() => {
      store.patch('t1', { effort: 'high' });
      expect(store.read('t1').effort).toBe('high');
      throw new Error('outer');
    })()).toThrow('outer');
    expect(raw().effort).toBeUndefined();
  });

  it('a patch from a second connection is kept by a patch from the first (two daemons parts, one file)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-config-'));
    try {
      const one = new Database(path.join(dir, 'd.db')); initSchema(one);
      sessionsDb.create(one, { id: 'S', provider: 'claude-code', name: 's', workingDir: '/tmp' });
      terminalsDb.create(one, { id: 't1', sessionId: 'S', type: 'claude-code', label: 't', config: { model: 'opus' } });
      const two = new Database(path.join(dir, 'd.db'));
      const s1 = new ThreadConfigStore(one); const s2 = new ThreadConfigStore(two);
      s1.read('t1'); s2.read('t1');
      s1.patch('t1', { effort: 'high' });
      s2.patch('t1', { scheduledWake: 'later' });
      expect(s1.read('t1')).toEqual({ model: 'opus', effort: 'high', scheduledWake: 'later' });
      one.close(); two.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('pickClientSettable', () => {
  it('keeps the keys of the allow-list and names the others', () => {
    const { patch, ignored } = pickClientSettable({ html: '<p>x</p>', url: 'https://example.com', role: 'coordinator', secretsEnv: true });
    expect(patch).toEqual({ html: '<p>x</p>', url: 'https://example.com' });
    expect(ignored.sort()).toEqual(['role', 'secretsEnv']);
  });

  it('passes null through, so a client can remove one of its keys', () => {
    expect(pickClientSettable({ html: null }).patch).toEqual({ html: null });
  });

  it('the allow-list holds no key that changes what a thread may do', () => {
    for (const k of ['role', 'roleAuthority', 'autonomy', 'secretsEnv', 'accountId', 'transport', 'runner', 'runnerPrompt', 'queued', 'queuedTask', 'spawnedBy', 'spawnDepth', 'model', 'signIn']) {
      expect(CLIENT_SETTABLE_KEYS as readonly string[]).not.toContain(k);
    }
  });
});
