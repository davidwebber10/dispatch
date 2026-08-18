// Structured-path twin of the StatusService ghost-heal tests: the manager's 'session'
// event (claude session_id from the structured init event) heals a stored external_id
// whose transcript no longer / never existed, and still never clobbers a healthy one.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { PTYManager } from '../../src/pty/manager.js';

vi.mock('../../src/sessions/transcript-path.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/sessions/transcript-path.js')>();
  return {
    ...orig,
    resolveTranscriptPath: vi.fn((workDir: string, sessionId: string) =>
      sessionId.startsWith('ghost') ? undefined : `/fake/${sessionId}.jsonl`),
  };
});

import { SessionService } from '../../src/sessions/service.js';

describe('structured session-id capture heals ghosts', () => {
  let db: Database.Database;
  let manager: EventEmitter;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 'proj', provider: 'claude-code', name: 'p', workingDir: '/x' });
    manager = new EventEmitter();
    // Minimal SessionService construction (db, a plain PTYManager, a throwaway mcp config
    // path) — mirrors the harness in tests/sessions/report-status.test.ts and
    // tests/sessions/terminal-id-env.test.ts, which both construct SessionService this way
    // and wire setStructuredManager with a fake. Only `.on` is exercised by this listener,
    // so a bare EventEmitter stands in for the structured manager.
    const service = new SessionService(db, new PTYManager(), '/tmp/dispatch-session-id-heal-test-mcp.json');
    service.setStructuredManager(manager as any);
  });

  it('captures on an id-less terminal (unchanged first-write behavior)', () => {
    terminalsDb.create(db, { id: 'tA', sessionId: 'proj', type: 'claude-code', label: 'a', skipPermissions: true });
    manager.emit('session', 'tA', 'real-1');
    expect(terminalsDb.getById(db, 'tA')?.external_id).toBe('real-1');
  });

  it('never clobbers a stored id whose transcript exists', () => {
    terminalsDb.create(db, { id: 'tB', sessionId: 'proj', type: 'claude-code', label: 'b', skipPermissions: true, externalId: 'orig' });
    manager.emit('session', 'tB', 'real-2');
    expect(terminalsDb.getById(db, 'tB')?.external_id).toBe('orig');
  });

  it('HEALS a stored ghost id to the live-reported one', () => {
    terminalsDb.create(db, { id: 'tC', sessionId: 'proj', type: 'claude-code', label: 'c', skipPermissions: true, externalId: 'ghost-1' });
    manager.emit('session', 'tC', 'real-3');
    expect(terminalsDb.getById(db, 'tC')?.external_id).toBe('real-3');
  });
});
