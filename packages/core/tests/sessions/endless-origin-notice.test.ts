// Endless Chat stage 2: a thread Chat started (config.origin 'endless') reports to Chat, never to
// the project's Control Plane, exactly like a scheduled role run.
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
  const svc = new SessionService(db, new NoopPty(), '/tmp/dispatch-endless-origin-test-mcp.json');
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
  terminalsDb.create(db, { id: 'chat', sessionId: 's1', type: 'claude-code', label: 'Fix login', config: { role: 'agent', agentType: 'implementer', origin: 'endless', spawnDepth: 1 } });
  const sent = vi.spyOn(svc, 'sendStructuredMessage').mockImplementation(() => {});
  const revived = vi.spyOn(svc, 'ensureStructuredAlive').mockReturnValue(true);
  return { svc, sent, revived };
}

const QUESTION = { toolName: 'AskUserQuestion', questions: [{ header: 'Fix', question: 'Which file?', options: ['a', 'b'] }] };

describe('a thread Chat started never reaches the Control Plane', () => {
  it('no notice on completion, on a question, on a stop, or on a direct message', () => {
    const { svc, sent, revived } = makeService();
    svc.noteAgentCompletion('chat');
    svc.noteAgentNeedsHelp('chat', 'which file?');
    expect(svc.routeAgentQuestionToCoordinator('chat', QUESTION)).toBe(false);
    svc.noteAgentLifecycle('chat', 'stopped');
    svc.noteUserMessageToAgent('chat', 'use b');
    expect(sent).not.toHaveBeenCalled();
    expect(revived).not.toHaveBeenCalled();
  });

  it('does not capture its owner-decisions block into the ledger', () => {
    const { svc } = makeService();
    const capture = vi.spyOn(svc as any, 'captureOwnerDecisions');
    svc.noteAgentCompletion('chat');
    expect(capture).not.toHaveBeenCalled();
  });

  it('finalOutput gives the last turn texts in order, or an empty string', () => {
    const { svc } = makeService();
    expect(svc.finalOutput('chat')).toBe('');
    vi.spyOn(svc as any, 'lastTurnTexts').mockReturnValue(['Done: login fixed.', 'Report: the cookie path was wrong.']);
    expect(svc.finalOutput('chat')).toBe('Report: the cookie path was wrong.\n\nDone: login fixed.');
  });
});
