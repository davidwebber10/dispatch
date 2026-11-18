import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import {
  InboxSecretStore, SECRET_ID_ALPHABET, newSecretId, normalizeSecretId, dotenvLine, upsertDotenv, configureInboxSecretClock, SECRET_TTL_MS,
} from '../../src/inbox/secret-store.js';

/**
 * "Send a secret" through the Inbox (2026-11-12): the owner hands a thread a secret by a short ID. The value
 * lives in a file of its own in the data dir (0600), never in the database and never in a plugin document.
 */
describe('inbox secret IDs', () => {
  it('an ID is 6 characters of an alphabet with no 0, O, 1, I or L', () => {
    for (const c of '0O1IL') expect(SECRET_ID_ALPHABET).not.toContain(c);
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = newSecretId();
      expect(id).toMatch(new RegExp(`^[${SECRET_ID_ALPHABET}]{6}$`));
      seen.add(id);
    }
    expect(seen.size).toBeGreaterThan(490);
  });

  it('normalizes what a model types: case, spaces and dashes; anything else is null', () => {
    expect(normalizeSecretId('k7q2m4')).toBe('K7Q2M4');
    expect(normalizeSecretId(' K7Q-2M4 ')).toBe('K7Q2M4');
    expect(normalizeSecretId('K7Q2M')).toBeNull();
    expect(normalizeSecretId('K7Q2M0')).toBeNull(); // 0 is not in the alphabet
    expect(normalizeSecretId(42)).toBeNull();
    expect(normalizeSecretId(undefined)).toBeNull();
  });
});

describe('dotenv lines', () => {
  it('a plain value is bare; spaces, # and quotes are quoted', () => {
    expect(dotenvLine('STRIPE_KEY', 'sk_live_abc123')).toBe('STRIPE_KEY=sk_live_abc123');
    expect(dotenvLine('A', 'two words')).toBe("A='two words'");
    expect(dotenvLine('A', 'x#y')).toBe("A='x#y'");
    expect(dotenvLine('A', `it's`)).toBe(`A="it's"`);
    expect(dotenvLine('A', `a'b"c`)).toBe('A=`a\'b"c`');
  });

  it('refuses a bad name and a value that one line cannot hold', () => {
    expect(() => dotenvLine('1BAD', 'x')).toThrow(/name/);
    expect(() => dotenvLine('A B', 'x')).toThrow(/name/);
    expect(() => dotenvLine('A', 'line1\nline2')).toThrow(/one line/);
    expect(() => dotenvLine('A', 'a\'b"c`d')).toThrow(/one line/);
  });

  it('upsert replaces an existing NAME= line (export kept), drops a duplicate, else appends', () => {
    expect(upsertDotenv('', 'K', 'v')).toBe('K=v\n');
    expect(upsertDotenv('A=1', 'K', 'v')).toBe('A=1\nK=v\n');
    expect(upsertDotenv('A=1\nK=old\nB=2\n', 'K', 'v')).toBe('A=1\nK=v\nB=2\n');
    expect(upsertDotenv('export K="old"\n', 'K', 'v')).toBe('export K=v\n');
    expect(upsertDotenv('K=1\n# c\nK=2\n', 'K', 'v')).toBe('K=v\n# c\n');
    expect(upsertDotenv('KEY=1\nK2=2\n', 'K', 'v')).toBe('KEY=1\nK2=2\nK=v\n');
    expect(upsertDotenv('A=1\r\nK=old\r\n', 'K', 'v')).toBe('A=1\r\nK=v\r\n');
  });
});

describe('the inbox secret store', () => {
  let db: Database.Database;
  let dir: string;
  let store: InboxSecretStore;
  let now: number;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-secret-store-'));
    db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'Alpha', workingDir: dir });
    now = Date.parse('2026-11-12T10:00:00Z');
    configureInboxSecretClock(() => now);
    store = new InboxSecretStore(db, dir);
  });
  afterEach(() => { configureInboxSecretClock(); fs.rmSync(dir, { recursive: true, force: true }); });

  const valueFile = (id: string) => path.join(dir, 'inbox-secrets', id);

  it('create stores the value in a 0600 file in a 0700 folder, and the record has no value', () => {
    const r = store.create({ name: 'Stripe key', value: 'sk_live_SECRET', sessionId: 'A', terminalId: null, allowReveal: false });
    expect(r).toMatchObject({ name: 'Stripe key', sessionId: 'A', terminalId: null, allowReveal: false, state: 'waiting', usedAt: null });
    expect(JSON.stringify(r)).not.toContain('sk_live_SECRET');
    expect(fs.readFileSync(valueFile(r.id), 'utf8')).toBe('sk_live_SECRET');
    expect(fs.statSync(valueFile(r.id)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, 'inbox-secrets')).mode & 0o777).toBe(0o700);
    // Not in the database.
    const dump = JSON.stringify(db.prepare('SELECT * FROM inbox_secrets').all());
    expect(dump).not.toContain('sk_live_SECRET');
    expect(Date.parse(r.expiresAt) - Date.parse(r.createdAt)).toBe(SECRET_TTL_MS);
  });

  it('list never carries a value', () => {
    store.create({ name: 'a', value: 'VALUE-ONE', sessionId: 'A', terminalId: null, allowReveal: true });
    expect(JSON.stringify(store.list())).not.toContain('VALUE-ONE');
  });

  it('markUsed deletes the value and keeps the record as used', () => {
    const r = store.create({ name: 'a', value: 'v', sessionId: 'A', terminalId: null, allowReveal: false });
    store.markUsed(r.id, { terminalId: 't1', label: 'Worker' }, { kind: 'file', path: '.env.local', name: 'A' });
    expect(fs.existsSync(valueFile(r.id))).toBe(false);
    expect(store.get(r.id)).toMatchObject({ state: 'used', usedBy: 't1', usedByLabel: 'Worker', usedTo: { kind: 'file', path: '.env.local', name: 'A' } });
    expect(store.readValue(r.id)).toBeNull();
  });

  it('a secret past 24 hours is expired when the store is read, and its value is deleted then (no timer)', () => {
    const r = store.create({ name: 'a', value: 'v', sessionId: 'A', terminalId: null, allowReveal: false });
    now += SECRET_TTL_MS - 1000;
    expect(store.get(r.id)?.state).toBe('waiting');
    expect(fs.existsSync(valueFile(r.id))).toBe(true);
    now += 2000;
    // Nothing happened by itself: the file is still there until a read.
    expect(fs.existsSync(valueFile(r.id))).toBe(true);
    expect(store.list()[0].state).toBe('expired');
    expect(fs.existsSync(valueFile(r.id))).toBe(false);
    expect(store.readValue(r.id)).toBeNull();
  });

  it('remove deletes the record and the value; a value file with no record is swept on read', () => {
    const r = store.create({ name: 'a', value: 'v', sessionId: 'A', terminalId: null, allowReveal: false });
    expect(store.remove(r.id)).toBe(true);
    expect(store.get(r.id)).toBeNull();
    expect(fs.existsSync(valueFile(r.id))).toBe(false);
    fs.writeFileSync(valueFile('ZZZZZZ'), 'orphan', { mode: 0o600 });
    store.list();
    expect(fs.existsSync(valueFile('ZZZZZZ'))).toBe(false);
  });
});
