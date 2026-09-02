// packages/core/tests/sessions/note-turn-outcome-truncation.test.ts
//
// Final-review Finding 2 (Critical): noteTurnOutcome truncates config.lastOutcome.summary to
// 400 chars for EVERY terminal, including a role-run runner whose final message ends with a
// fenced ```json contract block (see roles/seed.ts's OUTPUT_CONTRACT). A summary long enough to
// push the closing ``` fence past char 400 loses it entirely on truncation, so
// roles/service.ts#extractContract can't recover the JSON — a genuinely "failed" night silently
// records as 'ok' (no retry spawned, no 2-night-disable counter movement). A role-run terminal
// (config.roleRun set) gets a 4000-char cap instead; every other terminal keeps the existing
// 400-char cap unchanged.
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
  const svc = new SessionService(db, new NoopPty(), '/tmp/dispatch-note-turn-outcome-test-mcp.json');
  return { db, svc };
}

const readSummary = (db: Database.Database, terminalId: string): string =>
  JSON.parse(terminalsDb.getById(db, terminalId)?.config || '{}').lastOutcome.summary;

describe('SessionService.noteTurnOutcome — truncation cap', () => {
  it('a non-role thread still truncates a long summary at 400 chars (unchanged behavior)', () => {
    const { db, svc } = makeService();
    terminalsDb.create(db, { id: 'plain-term', sessionId: 's1', type: 'claude-code', label: 'T' });

    const longSummary = 'x'.repeat(1000);
    svc.noteTurnOutcome('plain-term', { summary: longSummary, needsHelp: false, inferred: true });

    expect(readSummary(db, 'plain-term')).toHaveLength(400);
  });

  it('a role-run terminal (config.roleRun set) keeps a 1000-char summary intact', () => {
    const { db, svc } = makeService();
    terminalsDb.create(db, {
      id: 'role-term',
      sessionId: 's1',
      type: 'claude-code',
      label: 'T',
      config: { roleRun: 'morning-digest' },
    });

    const longSummary = 'y'.repeat(1000);
    svc.noteTurnOutcome('role-term', { summary: longSummary, needsHelp: false, inferred: true });

    expect(readSummary(db, 'role-term')).toBe(longSummary);
    expect(readSummary(db, 'role-term')).toHaveLength(1000);
  });

  it('a role-run terminal still caps at 4000 chars for an even longer summary', () => {
    const { db, svc } = makeService();
    terminalsDb.create(db, {
      id: 'role-term-2',
      sessionId: 's1',
      type: 'claude-code',
      label: 'T',
      config: { roleRun: 'morning-digest' },
    });

    const longSummary = 'z'.repeat(5000);
    svc.noteTurnOutcome('role-term-2', { summary: longSummary, needsHelp: false, inferred: true });

    expect(readSummary(db, 'role-term-2')).toHaveLength(4000);
  });
});
