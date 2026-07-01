import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as messageSourceDb from '../../src/db/message-source.js';

function db() { const d = new Database(':memory:'); initSchema(d); return d; }

describe('message_source db', () => {
  let d: Database.Database;
  beforeEach(() => { d = db(); });

  it('records and looks up a source by (terminal_id, uuid)', () => {
    messageSourceDb.record(d, 't1', 'u1', 'coordinator');
    expect(messageSourceDb.getForUuids(d, 't1', ['u1'])).toEqual(new Map([['u1', 'coordinator']]));
  });

  it('scopes lookups to the given terminal_id — same uuid on a different terminal is invisible', () => {
    messageSourceDb.record(d, 't1', 'u1', 'coordinator');
    expect(messageSourceDb.getForUuids(d, 't2', ['u1'])).toEqual(new Map());
  });

  it('getForUuids returns only the uuids that were found (partial match)', () => {
    messageSourceDb.record(d, 't1', 'u1', 'user');
    const map = messageSourceDb.getForUuids(d, 't1', ['u1', 'u-missing']);
    expect(map.size).toBe(1);
    expect(map.get('u1')).toBe('user');
  });

  it('getForUuids returns an empty map for an empty uuid list (no query fired)', () => {
    expect(messageSourceDb.getForUuids(d, 't1', [])).toEqual(new Map());
  });

  it('re-recording the same (terminal_id, uuid) updates the source instead of erroring', () => {
    messageSourceDb.record(d, 't1', 'u1', 'user');
    messageSourceDb.record(d, 't1', 'u1', 'coordinator');
    expect(messageSourceDb.getForUuids(d, 't1', ['u1']).get('u1')).toBe('coordinator');
  });

  it('listUuids returns every uuid recorded for a terminal', () => {
    messageSourceDb.record(d, 't1', 'u1', 'user');
    messageSourceDb.record(d, 't1', 'u2', 'coordinator');
    messageSourceDb.record(d, 't2', 'u3', 'coordinator'); // different terminal — excluded
    expect(messageSourceDb.listUuids(d, 't1')).toEqual(new Set(['u1', 'u2']));
  });
});
