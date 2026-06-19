import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';

function createTestDb() {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

describe('sessions db', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('creates and retrieves a session', () => {
    const id = sessionsDb.create(db, {
      id: 'test-1',
      provider: 'claude-code',
      name: 'test session',
      workingDir: '/tmp/test',
    });
    const session = sessionsDb.getById(db, 'test-1');
    expect(session).not.toBeNull();
    expect(session!.name).toBe('test session');
    expect(session!.provider).toBe('claude-code');
    expect(session!.status).toBe('waiting');
  });

  it('lists non-archived sessions', () => {
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'one', workingDir: '/tmp' });
    sessionsDb.create(db, { id: 's2', provider: 'codex', name: 'two', workingDir: '/tmp' });
    sessionsDb.archive(db, 's2');
    const sessions = sessionsDb.list(db);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('s1');
  });

  it('updates session fields', () => {
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'old', workingDir: '/tmp' });
    sessionsDb.update(db, 's1', { name: 'new', notes: 'hello' });
    const session = sessionsDb.getById(db, 's1');
    expect(session!.name).toBe('new');
    expect(session!.notes).toBe('hello');
  });

  it('updates session status', () => {
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'test', workingDir: '/tmp' });
    sessionsDb.updateStatus(db, 's1', 'waiting');
    const session = sessionsDb.getById(db, 's1');
    expect(session!.status).toBe('waiting');
  });

  it('updates pid', () => {
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'test', workingDir: '/tmp' });
    sessionsDb.updatePid(db, 's1', 12345);
    const session = sessionsDb.getById(db, 's1');
    expect(session!.pid).toBe(12345);
  });

  it('updates lastActivityAt', () => {
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'test', workingDir: '/tmp' });
    const now = new Date().toISOString();
    sessionsDb.touchActivity(db, 's1');
    const session = sessionsDb.getById(db, 's1');
    expect(session!.last_activity_at).toBeDefined();
  });

  it('sets error on session', () => {
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'test', workingDir: '/tmp' });
    sessionsDb.setError(db, 's1', 'spawn failed: command not found');
    const session = sessionsDb.getById(db, 's1');
    expect(session!.error).toBe('spawn failed: command not found');
  });

  it('clears stale PIDs', () => {
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'alive', workingDir: '/tmp' });
    sessionsDb.create(db, { id: 's2', provider: 'claude-code', name: 'dead', workingDir: '/tmp' });
    sessionsDb.updatePid(db, 's1', 111);
    sessionsDb.updatePid(db, 's2', 222);

    const alivePids = new Set([111]);
    sessionsDb.clearStalePids(db, alivePids);

    const alive = sessionsDb.getById(db, 's1');
    expect(alive!.pid).toBe(111);
    expect(alive!.status).toBe('waiting');

    const dead = sessionsDb.getById(db, 's2');
    expect(dead!.pid).toBeNull();
    expect(dead!.status).toBe('waiting');
  });
});
