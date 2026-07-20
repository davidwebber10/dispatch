// packages/core/tests/sessions/report-status.test.ts
//
// Task 8: `reportStatus` must work for PTY/CLI threads too. The structured path (a live
// session) stores the declaration in-memory (StructuredSessionManager.noteDeclaredStatus,
// consulted at the `result` boundary) and MUST stay untouched. A PTY/CLI thread has no
// in-process session for the `Stop` hook (a separate request) to read, so its declaration
// has to survive on terminal.config.pendingDeclaration until StatusService.ingest consults
// it (see tests/status/service.test.ts for that half).
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';
import { StructuredSessionManager, type StatusDeclaration } from '../../src/structured/manager.js';

class NoopPty extends PTYManager {
  override spawn(): number { return 1; }
  override write(): void {}
  override resize(): void {}
  override kill(): void {}
  override getBuffer(): string { return ''; }
  override isAlive(): boolean { return false; }
  override killAll(): void {}
}

/** Captures noteDeclaredStatus calls and lets the test flip alive on/off, without
 *  spawning a real claude process (mirrors CapturingStructuredManager in
 *  tests/sessions/terminal-id-env.test.ts). */
class CapturingStructuredManager extends StructuredSessionManager {
  declaredCalls: { terminalId: string; decl: StatusDeclaration }[] = [];
  alive = true;
  override isAlive(): boolean { return this.alive; }
  override noteDeclaredStatus(terminalId: string, decl: StatusDeclaration): void {
    this.declaredCalls.push({ terminalId, decl });
  }
}

function makeService() {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  terminalsDb.create(db, { id: 'term', sessionId: 's1', type: 'claude-code', label: 'T' });
  const svc = new SessionService(db, new NoopPty(), '/tmp/dispatch-report-status-test-mcp.json');
  return { db, svc };
}

const decl: StatusDeclaration = { state: 'needs_you', summary: 'blocked on a decision', ask: 'which provider?' };

describe('SessionService.reportStatus', () => {
  it('falls back to persisting terminal.config.pendingDeclaration when there is no live structured session', () => {
    const { db, svc } = makeService();

    const ok = svc.reportStatus('term', decl);

    expect(ok).toBe(true);
    const cfg = JSON.parse(terminalsDb.getById(db, 'term')?.config || '{}');
    expect(cfg.pendingDeclaration).toEqual(decl);
  });

  it('returns false for a terminal that does not exist', () => {
    const { svc } = makeService();
    expect(svc.reportStatus('nope', decl)).toBe(false);
  });

  it('with a live structured session, uses the session and does NOT write pendingDeclaration', () => {
    const { db, svc } = makeService();
    const mgr = new CapturingStructuredManager();
    mgr.alive = true;
    svc.setStructuredManager(mgr);

    const ok = svc.reportStatus('term', decl);

    expect(ok).toBe(true);
    expect(mgr.declaredCalls).toEqual([{ terminalId: 'term', decl }]);
    const cfg = JSON.parse(terminalsDb.getById(db, 'term')?.config || '{}');
    expect(cfg.pendingDeclaration).toBeUndefined();
  });

  it('falls back when a structured manager is wired but this session is not alive', () => {
    const { db, svc } = makeService();
    const mgr = new CapturingStructuredManager();
    mgr.alive = false;
    svc.setStructuredManager(mgr);

    const ok = svc.reportStatus('term', decl);

    expect(ok).toBe(true);
    expect(mgr.declaredCalls).toHaveLength(0);
    const cfg = JSON.parse(terminalsDb.getById(db, 'term')?.config || '{}');
    expect(cfg.pendingDeclaration).toEqual(decl);
  });
});
