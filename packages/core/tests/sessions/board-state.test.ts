// packages/core/tests/sessions/board-state.test.ts
//
// Finding 2: `setBoardState` had zero direct test coverage against a real database. The route
// tests stub it with vi.fn() (never runs the real merge logic), and the status-service tests
// only seed `boardState` directly via terminalsDb.updateConfig to exercise the override-clearing
// half. None of that proves the read-modify-write merge in SessionService.setBoardState itself
// is correct — a regression that rebuilt `cfg` from scratch instead of merging would pass every
// existing test today.
//
// `setBoardState` is a sibling of `reportStatus` (also a terminal.config read-modify-write) —
// tests/sessions/report-status.test.ts is the precedent this file follows for setup.
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';

class NoopPty extends PTYManager {
  override spawn(): number { return 1; }
  override write(): void {}
  override resize(): void {}
  override kill(): void {}
  override getBuffer(): string { return ''; }
  override isAlive(): boolean { return false; }
  override killAll(): void {}
}

function makeService() {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  terminalsDb.create(db, { id: 'term', sessionId: 's1', type: 'claude-code', label: 'T' });
  const svc = new SessionService(db, new NoopPty(), '/tmp/dispatch-board-state-test-mcp.json');
  return { db, svc };
}

const readBoard = (db: Database.Database) => JSON.parse(terminalsDb.getById(db, 'term')?.config || '{}').boardState;

describe('SessionService.setBoardState', () => {
  it('acknowledge -> read back -> acknowledgedAt present; then acknowledged:false -> read back -> NOT acknowledged', () => {
    const { db, svc } = makeService();

    expect(svc.setBoardState('term', { acknowledged: true })).toBe(true);
    let board = readBoard(db);
    expect(typeof board.acknowledgedAt).toBe('string');
    expect(board.acknowledgedAt.length).toBeGreaterThan(0);

    // The implementation sets acknowledgedAt to `undefined` here, and JSON.stringify DROPS
    // undefined-valued keys — so on read-back the key is simply absent, not null. Assert the
    // observable behaviour (falsy / no truthy acknowledgedAt), not the literal storage shape.
    expect(svc.setBoardState('term', { acknowledged: false })).toBe(true);
    board = readBoard(db);
    expect(board.acknowledgedAt).toBeFalsy();
    expect('acknowledgedAt' in board).toBe(false);
  });

  it('setting an override leaves a previously-written lastOutcome intact', () => {
    const { db, svc } = makeService();
    svc.noteTurnOutcome('term', { summary: 'shipped it', needsHelp: false, inferred: true });

    expect(svc.setBoardState('term', { override: 'complete' })).toBe(true);

    const cfg = JSON.parse(terminalsDb.getById(db, 'term')?.config || '{}');
    expect(cfg.lastOutcome).toMatchObject({ summary: 'shipped it', needsHelp: false, inferred: true });
    expect(cfg.boardState).toMatchObject({ override: 'complete' });
  });

  it('writing lastOutcome after setting an override leaves the override intact', () => {
    const { db, svc } = makeService();

    expect(svc.setBoardState('term', { override: 'needs_help' })).toBe(true);
    svc.noteTurnOutcome('term', { summary: 'blocked on a decision', needsHelp: true, inferred: false });

    const cfg = JSON.parse(terminalsDb.getById(db, 'term')?.config || '{}');
    expect(cfg.boardState).toMatchObject({ override: 'needs_help' });
    expect(cfg.lastOutcome).toMatchObject({ summary: 'blocked on a decision', needsHelp: true, inferred: false });
  });

  it('setting acknowledged does not disturb an existing override', () => {
    const { db, svc } = makeService();
    expect(svc.setBoardState('term', { override: 'resting' })).toBe(true);

    expect(svc.setBoardState('term', { acknowledged: true })).toBe(true);

    const board = readBoard(db);
    expect(board.override).toBe('resting');
    expect(typeof board.acknowledgedAt).toBe('string');
  });

  it('setting an override does not disturb an existing acknowledgedAt', () => {
    const { db, svc } = makeService();
    expect(svc.setBoardState('term', { acknowledged: true })).toBe(true);
    const ackedAt = readBoard(db).acknowledgedAt;

    expect(svc.setBoardState('term', { override: 'complete' })).toBe(true);

    const board = readBoard(db);
    expect(board.acknowledgedAt).toBe(ackedAt);
    expect(board.override).toBe('complete');
  });

  it('returns false for a terminal that does not exist', () => {
    const { svc } = makeService();
    expect(svc.setBoardState('nope', { acknowledged: true })).toBe(false);
  });
});
