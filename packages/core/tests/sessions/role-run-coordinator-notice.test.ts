// packages/core/tests/sessions/role-run-coordinator-notice.test.ts
//
// GPT-6 Astra review of PR #48, finding 3: a scheduled role run is a `role: 'agent'` thread in
// its project's session, so every coordinator notice (completion, needs-help, a question, a
// stop, a direct message) went to — and revived — that project's coordinator, inviting it to
// "spawn a follow-up" or answer the role's question. The roles design says no agent supervises
// an agent (§3; coordinator routing is a future hook, not v1). A role run (config.roleRun set)
// never notifies the coordinator; its questions fall back to the human. A coordinator-spawned
// agent keeps every notice unchanged.
import { describe, it, expect, vi } from 'vitest';
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
  const svc = new SessionService(db, new NoopPty(), '/tmp/dispatch-role-run-notice-test-mcp.json');
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
  terminalsDb.create(db, { id: 'worker', sessionId: 's1', type: 'claude-code', label: 'worker', config: { role: 'agent', agentType: 'implementer' } });
  terminalsDb.create(db, {
    id: 'role', sessionId: 's1', type: 'claude-code', label: 'nightly-check · 2026-09-24',
    config: { role: 'agent', agentType: 'researcher', mission: 'nightly-check', roleRun: 'nightly-check', roleAuthority: 'stage', spawnDepth: 1 },
  });
  const revived = vi.spyOn(svc, 'ensureStructuredAlive').mockReturnValue(true);
  const sent = vi.spyOn(svc, 'sendStructuredMessage').mockImplementation(() => {});
  return { svc, revived, sent };
}

const QUESTION = { toolName: 'AskUserQuestion', questions: [{ header: 'Fix', question: 'Stage the fix?', options: ['yes', 'no'] }] };

describe('coordinator notices — a scheduled role run never reaches the coordinator', () => {
  it('a coordinator-spawned agent still notifies its coordinator (unchanged)', () => {
    const { svc, sent } = makeService();
    svc.noteAgentCompletion('worker');
    svc.noteAgentNeedsHelp('worker', 'which branch?');
    expect(svc.routeAgentQuestionToCoordinator('worker', QUESTION)).toBe(true);
    expect(sent.mock.calls.map((c) => c[0])).toEqual(['coord', 'coord', 'coord']);
  });

  it('a role run does not notify or revive the coordinator when its turn completes', () => {
    const { svc, sent, revived } = makeService();
    svc.noteAgentCompletion('role');
    expect(sent).not.toHaveBeenCalled();
    expect(revived).not.toHaveBeenCalled();
  });

  it('a role run does not notify the coordinator when it stops to ask', () => {
    const { svc, sent, revived } = makeService();
    svc.noteAgentNeedsHelp('role', 'Spawn an implementer to commit this fix');
    expect(sent).not.toHaveBeenCalled();
    expect(revived).not.toHaveBeenCalled();
  });

  it("a role run's AskUserQuestion falls back to the human instead of the coordinator", () => {
    const { svc, sent } = makeService();
    expect(svc.routeAgentQuestionToCoordinator('role', QUESTION)).toBe(false);
    expect(sent).not.toHaveBeenCalled();
  });

  it('a user stop or direct message to a role run does not notify the coordinator', () => {
    const { svc, sent } = makeService();
    svc.noteAgentLifecycle('role', 'stopped');
    svc.noteUserMessageToAgent('role', 'skip tonight');
    expect(sent).not.toHaveBeenCalled();
  });
});
