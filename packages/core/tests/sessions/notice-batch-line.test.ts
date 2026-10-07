// Every agent notice ends with the Batch line (structured-recap spec, Unit 4).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import type { IStructuredManager } from '../../src/structured/manager.js';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as ledgerDb from '../../src/db/ledger.js';
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

const BUSY = 'Batch: still working — 1 agent ("Build X").\n' +
  'Do not post a recap. If this needs a decision, add it with ledger_add\n' +
  'and post only that item. Otherwise write at most one line.\n' +
  'Open ledger items: N1.';
const SETTLED = 'Batch: no other agent is working or queued.\n' +
  'If you start a next step now, write at most one line.\n' +
  'If you start nothing, the batch has settled: post the recap now\n' +
  '(ledger_list with forRecap, and list_agents).\n' +
  'Open ledger items: N1.';

function makeService() {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  const svc = new SessionService(db, new NoopPty(), '/tmp/dispatch-batch-line-test-mcp.json');
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
  terminalsDb.create(db, { id: 'a', sessionId: 's1', type: 'claude-code', label: 'Subject', config: { role: 'agent', agentType: 'implementer' } });
  terminalsDb.create(db, { id: 'b', sessionId: 's1', type: 'claude-code', label: 'Build X', config: { role: 'agent', agentType: 'implementer' } });
  ledgerDb.create(db, { sessionId: 's1', kind: 'go', text: 'Merge PR #12.', author: 'overseer' });
  vi.spyOn(svc, 'ensureStructuredAlive').mockReturnValue(true);
  const sent = vi.spyOn(svc, 'sendStructuredMessage').mockImplementation(() => {});
  return { db, svc, sent };
}

const QUESTION = { toolName: 'AskUserQuestion', questions: [{ header: 'Fix', question: 'Stage the fix?', options: ['yes', 'no'] }] };

afterEach(() => { vi.restoreAllMocks(); });

const fire = {
  finished: (svc: SessionService) => svc.noteAgentCompletion('a'),
  blocked: (svc: SessionService) => svc.noteAgentNeedsHelp('a', 'which branch?'),
  question: (svc: SessionService) => { svc.routeAgentQuestionToCoordinator('a', QUESTION); },
  stopped: (svc: SessionService) => svc.noteAgentLifecycle('a', 'stopped'),
};

describe('Batch line on agent notices', () => {
  for (const [kind, run] of Object.entries(fire)) {
    it(`${kind}: busy footer while another agent works, settled footer when none does`, () => {
      const { db, svc, sent } = makeService();
      terminalsDb.updateStatus(db, 'a', 'working'); // the subject itself never counts
      terminalsDb.updateStatus(db, 'b', 'working');
      run(svc);
      expect(sent.mock.calls[0][0]).toBe('coord');
      expect(String(sent.mock.calls[0][1]).endsWith(`\n\n${BUSY}`)).toBe(true);

      terminalsDb.updateStatus(db, 'b', 'waiting');
      run(svc);
      expect(String(sent.mock.calls[1][1]).endsWith(`\n\n${SETTLED}`)).toBe(true);
    });
  }

  it('direct message: the subject is about to work on the user\'s message, so the batch reads busy', () => {
    const { svc, sent } = makeService();
    svc.noteUserMessageToAgent('a', 'use the staging bucket');
    const text = String(sent.mock.calls[0][1]);
    expect(text.startsWith('💬 The user just sent your agent "Subject"')).toBe(true);
    expect(text).toContain('Batch: still working — 1 agent ("Subject").');
  });

  it('direct message to an agent paused on a question: it counts as waiting on you, not working', () => {
    const { db, svc, sent } = makeService();
    terminalsDb.updateStatus(db, 'a', 'working');
    // The real lookup: the structured manager holds the agent's pending question.
    const manager = Object.assign(new EventEmitter(), {
      getPending: (id: string) => (id === 'a' ? { requestId: 'r1', toolName: 'AskUserQuestion', input: {}, questions: QUESTION.questions } : null),
    });
    svc.setStructuredManager(manager as unknown as IStructuredManager);
    svc.noteUserMessageToAgent('a', 'use the staging bucket');
    const text = String(sent.mock.calls[0][1]);
    expect(text).toContain('Batch: no other agent is working or queued.\nStill 1 agent waiting on you ("Subject").');
    expect(text).not.toContain('Batch: still working');
  });

  it('a failed batch computation never drops the notice: it goes out without the Batch line', () => {
    const { svc, sent } = makeService();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(svc, 'batchState').mockImplementation(() => { throw new Error('db is closing'); });
    svc.noteAgentCompletion('a');
    const text = String(sent.mock.calls[0][1]);
    expect(text).toContain('just finished a turn');
    expect(text).not.toContain('Batch:');
    expect(err).toHaveBeenCalled();
  });

  it('a failed open-items lookup never drops the notice either', () => {
    const { db, svc, sent } = makeService();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db.exec('DROP TABLE ledger_items'); // listOpenSeqs now throws
    svc.noteAgentNeedsHelp('a', 'which branch?');
    expect(sent).toHaveBeenCalledTimes(1);
    expect(String(sent.mock.calls[0][1])).not.toContain('Batch:');
  });

  it('finished: a dependent promoted this instant counts as working although it reads waiting', () => {
    const { db, svc, sent } = makeService();
    terminalsDb.create(db, { id: 'dep', sessionId: 's1', type: 'claude-code', label: 'Review Y', config: { role: 'agent', dependsOn: 'a', queued: true, queuedTask: 'review' } });
    terminalsDb.updateStatus(db, 'dep', 'queued');
    vi.spyOn(svc, 'startQueuedTerminal').mockImplementation((id: string) => {
      terminalsDb.updateStatus(db, id, 'waiting');
      return svc.getTerminal(id);
    });
    svc.noteAgentCompletion('a');
    expect(String(sent.mock.calls[0][1])).toContain('Batch: still working — 1 agent ("Review Y").');
  });

  it('finished: the notice no longer says "or report back to the user"', () => {
    const { svc, sent } = makeService();
    svc.noteAgentCompletion('a');
    const text = String(sent.mock.calls[0][1]);
    expect(text).toContain('just finished a turn');
    expect(text).toContain('ingest the result, hand it to another agent, or spawn a follow-up.');
    expect(text).not.toContain('report back to the user');
  });
});
