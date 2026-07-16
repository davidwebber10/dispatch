import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';

function createTestDb() {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

describe('terminals db', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    // Create a session to attach terminals to
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'test session', workingDir: '/tmp/test' });
  });

  it('creates and retrieves a terminal', () => {
    terminalsDb.create(db, {
      id: 't1',
      sessionId: 's1',
      type: 'claude-code',
      label: 'Claude Code',
    });
    const terminal = terminalsDb.getById(db, 't1');
    expect(terminal).not.toBeNull();
    expect(terminal!.session_id).toBe('s1');
    expect(terminal!.type).toBe('claude-code');
    expect(terminal!.label).toBe('Claude Code');
    expect(terminal!.pid).toBeNull();
  });

  it('touchActivity stamps last_activity_at', () => {
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Claude Code' });
    expect(terminalsDb.getById(db, 't1')!.last_activity_at).toBeNull();
    terminalsDb.touchActivity(db, 't1');
    expect(terminalsDb.getById(db, 't1')!.last_activity_at).toBeTruthy();
  });

  it('lists terminals by session', () => {
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Claude Code' });
    terminalsDb.create(db, { id: 't2', sessionId: 's1', type: 'shell', label: 'Terminal' });

    const terminals = terminalsDb.listBySession(db, 's1');
    expect(terminals).toHaveLength(2);
    expect(terminals[0].id).toBe('t1');
    expect(terminals[1].id).toBe('t2');
  });

  it('does not list terminals from other sessions', () => {
    sessionsDb.create(db, { id: 's2', provider: 'codex', name: 'other', workingDir: '/tmp' });
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Claude Code' });
    terminalsDb.create(db, { id: 't2', sessionId: 's2', type: 'codex', label: 'Codex' });

    const terminals = terminalsDb.listBySession(db, 's1');
    expect(terminals).toHaveLength(1);
    expect(terminals[0].id).toBe('t1');
  });

  it('updates pid', () => {
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'shell', label: 'Terminal' });
    terminalsDb.updatePid(db, 't1', 12345);
    const terminal = terminalsDb.getById(db, 't1');
    expect(terminal!.pid).toBe(12345);
  });

  it('updates external_id', () => {
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Claude Code' });
    terminalsDb.updateExternalId(db, 't1', 'ext-123');
    const terminal = terminalsDb.getById(db, 't1');
    expect(terminal!.external_id).toBe('ext-123');
  });

  it('removes a terminal', () => {
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'shell', label: 'Terminal' });
    terminalsDb.remove(db, 't1');
    const terminal = terminalsDb.getById(db, 't1');
    expect(terminal).toBeNull();
  });

  it('removes all terminals for a session', () => {
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Claude Code' });
    terminalsDb.create(db, { id: 't2', sessionId: 's1', type: 'shell', label: 'Terminal' });
    terminalsDb.removeBySession(db, 's1');
    const terminals = terminalsDb.listBySession(db, 's1');
    expect(terminals).toHaveLength(0);
  });

  it('rowToTerminal converts correctly', () => {
    terminalsDb.create(db, {
      id: 't1',
      sessionId: 's1',
      type: 'claude-code',
      label: 'Claude Code',
      skipPermissions: true,
    });
    const row = terminalsDb.getById(db, 't1')!;
    const terminal = terminalsDb.rowToTerminal(row);
    expect(terminal.id).toBe('t1');
    expect(terminal.sessionId).toBe('s1');
    expect(terminal.type).toBe('claude-code');
    expect(terminal.label).toBe('Claude Code');
    expect(terminal.skipPermissions).toBe(true);
    expect(terminal.pid).toBeNull();
    expect(terminal.externalId).toBeNull();
    expect(terminal.createdAt).toBeDefined();
  });

  describe('label_source', () => {
    it('create stamps the provided labelSource', () => {
      terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'My name', labelSource: 'user' });
      expect(terminalsDb.getById(db, 't1')!.label_source).toBe('user');

      terminalsDb.create(db, { id: 't2', sessionId: 's1', type: 'claude-code', label: 'Claude Code', labelSource: 'default' });
      expect(terminalsDb.getById(db, 't2')!.label_source).toBe('default');
    });

    it('create defaults labelSource to user when omitted', () => {
      terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Claude Code' });
      expect(terminalsDb.getById(db, 't1')!.label_source).toBe('user');
    });

    it('rowToTerminal converts label_source to camelCase', () => {
      terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Claude Code', labelSource: 'default' });
      const terminal = terminalsDb.rowToTerminal(terminalsDb.getById(db, 't1')!);
      expect(terminal.labelSource).toBe('default');
    });

    it('updateLabel stamps user', () => {
      terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Claude Code', labelSource: 'default' });
      terminalsDb.updateLabel(db, 't1', 'Renamed');
      const terminal = terminalsDb.getById(db, 't1');
      expect(terminal!.label).toBe('Renamed');
      expect(terminal!.label_source).toBe('user');
    });

    it('setAutoLabel only fires on default rows', () => {
      terminalsDb.create(db, { id: 'd1', sessionId: 's1', type: 'claude-code', label: 'Claude Code', labelSource: 'default' });
      expect(terminalsDb.setAutoLabel(db, 'd1', 'Fix the login bug')).toBe(true);
      let terminal = terminalsDb.getById(db, 'd1');
      expect(terminal!.label).toBe('Fix the login bug');
      expect(terminal!.label_source).toBe('auto');

      // second auto attempt: frozen
      expect(terminalsDb.setAutoLabel(db, 'd1', 'Other')).toBe(false);
      expect(terminalsDb.getById(db, 'd1')!.label).toBe('Fix the login bug');

      // user row: frozen
      terminalsDb.create(db, { id: 'u1', sessionId: 's1', type: 'claude-code', label: 'Claude Code', labelSource: 'user' });
      expect(terminalsDb.setAutoLabel(db, 'u1', 'Nope')).toBe(false);
      expect(terminalsDb.getById(db, 'u1')!.label).toBe('Claude Code');
    });
  });
});
