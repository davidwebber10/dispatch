import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { SessionService } from './service.js';
import {
  DEFAULT_AUTO_ARCHIVE_MS,
  getAutoArchiveMs,
  withAutoArchive,
  autoArchiveTick,
} from './auto-archive.js';

const fakePty = { isAlive: () => false, kill: () => {} } as any;
const fakeBroadcaster = { broadcast: () => {} } as any;

let dir: string;
let db: Database.Database;
let svc: SessionService;

/** Create a thread with an explicit status, config and last_activity_at. */
function seedThread(id: string, opts: {
  status?: string;
  config?: Record<string, any>;
  idleMs?: number;          // how long ago it was last active
} = {}) {
  terminalsDb.create(db, { id, sessionId: 's1', type: 'claude-code', label: id, config: opts.config ?? {} });
  if (opts.status) terminalsDb.updateStatus(db, id, opts.status);
  const at = new Date(Date.now() - (opts.idleMs ?? 0)).toISOString();
  db.prepare('UPDATE terminals SET last_activity_at = ? WHERE id = ?').run(at, id);
}

const archived = (id: string) => !!terminalsDb.getById(db, id)?.archived_at;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-autoarchive-'));
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: '/tmp/proj' });
  svc = new SessionService(db, fakePty, path.join(dir, 'mcp.json'));
});
afterEach(() => {
  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe('auto-archive policy helpers', () => {
  it('reads a policy off a config blob', () => {
    expect(getAutoArchiveMs({ autoArchive: true, autoArchiveMs: 1000 })).toBe(1000);
  });

  it('defaults to 12 hours when enabled with no explicit duration', () => {
    expect(getAutoArchiveMs({ autoArchive: true })).toBe(DEFAULT_AUTO_ARCHIVE_MS);
    expect(DEFAULT_AUTO_ARCHIVE_MS).toBe(43_200_000);
  });

  it('returns null for a thread that did not opt in', () => {
    expect(getAutoArchiveMs({})).toBeNull();
    expect(getAutoArchiveMs({ autoArchive: false, autoArchiveMs: 1000 })).toBeNull();
    expect(getAutoArchiveMs({ transport: 'structured' })).toBeNull();
  });

  it('ignores a non-positive or non-numeric duration', () => {
    expect(getAutoArchiveMs({ autoArchive: true, autoArchiveMs: 0 })).toBe(DEFAULT_AUTO_ARCHIVE_MS);
    expect(getAutoArchiveMs({ autoArchive: true, autoArchiveMs: -5 })).toBe(DEFAULT_AUTO_ARCHIVE_MS);
    expect(getAutoArchiveMs({ autoArchive: true, autoArchiveMs: 'soon' as any })).toBe(DEFAULT_AUTO_ARCHIVE_MS);
  });

  it('merges the policy onto an existing config without dropping other keys', () => {
    const next = withAutoArchive({ transport: 'structured', role: 'agent' }, true, 60_000);
    expect(next).toEqual({ transport: 'structured', role: 'agent', autoArchive: true, autoArchiveMs: 60_000 });
  });

  it('strips both policy keys when disabled, preserving the rest', () => {
    const next = withAutoArchive({ transport: 'structured', autoArchive: true, autoArchiveMs: 60_000 }, false);
    expect(next).toEqual({ transport: 'structured' });
  });
});

describe('autoArchiveTick', () => {
  it('archives an opted-in thread that is past its deadline', () => {
    seedThread('t1', { status: 'waiting', config: { autoArchive: true, autoArchiveMs: 60_000 }, idleMs: 120_000 });
    expect(autoArchiveTick(db, svc, fakeBroadcaster)).toEqual(['t1']);
    expect(archived('t1')).toBe(true);
  });

  it('leaves an opted-in thread that is still inside its deadline', () => {
    seedThread('t1', { status: 'waiting', config: { autoArchive: true, autoArchiveMs: 60_000 }, idleMs: 30_000 });
    expect(autoArchiveTick(db, svc, fakeBroadcaster)).toEqual([]);
    expect(archived('t1')).toBe(false);
  });

  it('never touches a thread that did not opt in, however old', () => {
    seedThread('t1', { status: 'waiting', config: {}, idleMs: 999 * 24 * 3600_000 });
    expect(autoArchiveTick(db, svc, fakeBroadcaster)).toEqual([]);
    expect(archived('t1')).toBe(false);
  });

  it('never touches a thread whose config blob is malformed', () => {
    seedThread('t1', { status: 'waiting', config: {}, idleMs: 120_000 });
    db.prepare('UPDATE terminals SET config = ? WHERE id = ?').run('{not json', 't1');
    expect(autoArchiveTick(db, svc, fakeBroadcaster)).toEqual([]);
    expect(archived('t1')).toBe(false);
  });

  it('archives an errored thread (nobody is blocked on it)', () => {
    seedThread('t1', { status: 'error', config: { autoArchive: true, autoArchiveMs: 60_000 }, idleMs: 120_000 });
    expect(autoArchiveTick(db, svc, fakeBroadcaster)).toEqual(['t1']);
    expect(archived('t1')).toBe(true);
  });

  it.each(['working', 'queued', 'scheduled', 'needs_input'])(
    'never archives a %s thread, however idle — something is blocked on it',
    (status) => {
      seedThread('t1', { status, config: { autoArchive: true, autoArchiveMs: 60_000 }, idleMs: 999 * 3600_000 });
      expect(autoArchiveTick(db, svc, fakeBroadcaster)).toEqual([]);
      expect(archived('t1')).toBe(false);
    },
  );

  it('never re-archives an already-archived thread', () => {
    seedThread('t1', { status: 'waiting', config: { autoArchive: true, autoArchiveMs: 60_000 }, idleMs: 120_000 });
    terminalsDb.archive(db, 't1');
    expect(autoArchiveTick(db, svc, fakeBroadcaster)).toEqual([]);
  });

  it('falls back to created_at when the thread never recorded activity', () => {
    // A thread that has never done anything has a NULL last_activity_at; measuring
    // from created_at is the correct conservative reading.
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 't1', config: { autoArchive: true, autoArchiveMs: 60_000 } });
    db.prepare('UPDATE terminals SET last_activity_at = NULL, created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 120_000).toISOString(), 't1');
    expect(autoArchiveTick(db, svc, fakeBroadcaster)).toEqual(['t1']);
  });

  it('broadcasts terminal:removed and session:tabs-changed for each archived thread', () => {
    seedThread('t1', { status: 'waiting', config: { autoArchive: true, autoArchiveMs: 60_000 }, idleMs: 120_000 });
    const sent: any[] = [];
    autoArchiveTick(db, svc, { broadcast: (m: any) => sent.push(m) } as any);
    expect(sent).toEqual([
      { type: 'terminal:removed', terminalId: 't1', sessionId: 's1' },
      { type: 'session:tabs-changed', sessionId: 's1' },
    ]);
  });

  it.each(['notes', 'browser'])(
    'never sweeps a %s tab, even with an autoArchive policy and an ancient timestamp — it has no activity signal',
    (type) => {
      const ancient = new Date(Date.now() - 999 * 24 * 3600_000).toISOString();
      terminalsDb.create(db, {
        id: 't1',
        sessionId: 's1',
        type,
        label: 't1',
        config: { autoArchive: true, autoArchiveMs: 60_000 },
      });
      db.prepare('UPDATE terminals SET status = ?, created_at = ?, last_activity_at = ? WHERE id = ?')
        .run('waiting', ancient, ancient, 't1');
      expect(autoArchiveTick(db, svc, fakeBroadcaster)).toEqual([]);
      expect(archived('t1')).toBe(false);
    },
  );

  it('keeps sweeping after one thread fails to archive', () => {
    seedThread('t1', { status: 'waiting', config: { autoArchive: true, autoArchiveMs: 60_000 }, idleMs: 120_000 });
    seedThread('t2', { status: 'waiting', config: { autoArchive: true, autoArchiveMs: 60_000 }, idleMs: 120_000 });
    const exploding = {
      removeTerminal: (id: string) => {
        if (id === 't1') throw new Error('pty refuses to die');
        svc.removeTerminal(id);
      },
    } as any;
    expect(autoArchiveTick(db, exploding, fakeBroadcaster)).toEqual(['t2']);
    expect(archived('t2')).toBe(true);
  });
});
