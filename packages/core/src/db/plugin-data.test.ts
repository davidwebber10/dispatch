import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from './schema.js';
import { DOC_MAX_BYTES, DOCS_MAX, getDoc, setDoc, deleteDoc, listDocs, clearPlugin, getSettings, setSettings } from './plugin-data.js';

describe('plugin data (2026-11-07)', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initSchema(db); });

  it('set then get round-trips JSON and records the writer and size', () => {
    const writer = { terminalId: 't1', sessionId: 's1', label: 'Worker' };
    const doc = setDoc(db, 'p', 'pins', { ids: ['a', 'b'] }, writer);
    expect(doc).toMatchObject({ key: 'pins', value: { ids: ['a', 'b'] }, writer, bytes: JSON.stringify({ ids: ['a', 'b'] }).length });
    expect(doc.updatedAt).toMatch(/^\d{4}-/);
    expect(getDoc(db, 'p', 'pins')).toEqual(doc);
    expect(getDoc(db, 'p', 'nope')).toBeNull();
    expect(getDoc(db, 'other', 'pins')).toBeNull();
    expect(setDoc(db, 'p', 'pins', 1, null).writer).toBeNull();
    expect(getDoc(db, 'p', 'pins')!.value).toBe(1);
  });

  it('set over the size cap throws too large and leaves the old value', () => {
    setDoc(db, 'p', 'big', 'small', null);
    expect(() => setDoc(db, 'p', 'big', 'x'.repeat(DOC_MAX_BYTES), null)).toThrow('too large');
    expect(getDoc(db, 'p', 'big')!.value).toBe('small');
  });

  it('the document after the cap throws too many; replacing an existing key is fine', () => {
    for (let i = 0; i < DOCS_MAX; i++) setDoc(db, 'p', `k${i}`, i, null);
    expect(() => setDoc(db, 'p', 'one-more', 1, null)).toThrow('too many');
    expect(setDoc(db, 'p', 'k0', 'replaced', null).value).toBe('replaced');
    expect(setDoc(db, 'other', 'k', 1, null).key).toBe('k');
  });

  it('a bad key throws', () => {
    for (const k of ['', 'a b', 'x'.repeat(129), 'a/b', '../x']) expect(() => setDoc(db, 'p', k, 1, null), k).toThrow('bad key');
    for (const k of ['a', 'a.b-c_d:e', '0']) expect(setDoc(db, 'p', k, 1, null).key).toBe(k);
  });

  it('list omits values and sorts by key; delete returns whether it existed; clearPlugin drops data and settings', () => {
    setDoc(db, 'p', 'b', { x: 1 }, null); setDoc(db, 'p', 'a', 'v', null); setDoc(db, 'q', 'z', 1, null);
    setSettings(db, 'p', { hours: 24 });
    const list = listDocs(db, 'p');
    expect(list.map((d) => d.key)).toEqual(['a', 'b']);
    expect((list[0] as { value?: unknown }).value).toBeUndefined();
    expect(list[1].bytes).toBe(JSON.stringify({ x: 1 }).length);
    expect(deleteDoc(db, 'p', 'a')).toBe(true);
    expect(deleteDoc(db, 'p', 'a')).toBe(false);
    clearPlugin(db, 'p');
    expect(listDocs(db, 'p')).toEqual([]);
    expect(getSettings(db, 'p')).toBeNull();
    expect(listDocs(db, 'q')).toHaveLength(1);
  });

  it('settings round-trip', () => {
    expect(getSettings(db, 'p')).toBeNull();
    const s = setSettings(db, 'p', { style: 'quiet' });
    expect(s.value).toEqual({ style: 'quiet' });
    expect(getSettings(db, 'p')).toEqual(s);
    expect(setSettings(db, 'p', { style: 'direct' }).value).toEqual({ style: 'direct' });
    expect(() => setSettings(db, 'p', 'x'.repeat(DOC_MAX_BYTES))).toThrow('too large');
  });
});
