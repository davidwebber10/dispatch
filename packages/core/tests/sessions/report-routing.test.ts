// Report routing: a worker's notices go to the thread that started it. Only a worker the overseer
// started (or an old row with no starter) reports to the overseer. A child of a Chat thread reports
// to Chat. A starter that is gone, stopped or archived is not revived and the notice is dropped.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import type { IStructuredManager } from '../../src/structured/manager.js';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as ledgerDb from '../../src/db/ledger.js';
import { computeBatchState } from '../../src/sessions/batch-state.js';
import { interimRecapTick } from '../../src/sessions/interim-recap.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';

class FakePty extends PTYManager {
  alive = new Set<string>();
  writes: { id: string; data: string }[] = [];
  override spawn(): number { return 1; }
  override write(id: string, data: string): void { this.writes.push({ id, data }); }
  override resize(): void {}
  override kill(): void {}
  override getBuffer(): string { return ''; }
  override isAlive(id: string): boolean { return this.alive.has(id); }
  override killAll(): void {}
}

const QUESTION = { toolName: 'AskUserQuestion', questions: [{ header: 'Fix', question: 'Stage the fix?', options: ['yes', 'no'] }] };

function makeService() {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  const pty = new FakePty();
  const svc = new SessionService(db, pty, '/tmp/dispatch-report-routing-test-mcp.json');
  const live = new Set<string>(['coord', 'u']);
  const manager = Object.assign(new EventEmitter(), {
    isAlive: (id: string) => live.has(id),
    getPending: () => null,
    getEvents: () => [],
    getTurnTexts: () => [],
    sendMessage: vi.fn(),
  });
  svc.setStructuredManager(manager as unknown as IStructuredManager);
  const mk = (id: string, label: string, config: Record<string, unknown>, type = 'claude-code') =>
    terminalsDb.create(db, { id, sessionId: 's1', type, label, config });
  mk('coord', 'Control Plane', { role: 'coordinator', transport: 'structured' });
  mk('u', 'My thread', { transport: 'structured' }); // a plain thread the user opened
  const sent = vi.spyOn(svc, 'sendStructuredMessage').mockImplementation(() => {});
  const revived = vi.spyOn(svc, 'ensureStructuredAlive').mockReturnValue(true);
  const to = (id: string) => sent.mock.calls.filter((c) => c[0] === id).map((c) => String(c[1]));
  return { db, svc, pty, live, mk, sent, revived, to };
}

type Ctx = ReturnType<typeof makeService>;
const fire: Record<string, (svc: SessionService) => unknown> = {
  finished: (svc) => svc.noteAgentCompletion('w'),
  blocked: (svc) => svc.noteAgentNeedsHelp('w', 'which branch?'),
  question: (svc) => svc.routeAgentQuestionToCoordinator('w', QUESTION),
  stopped: (svc) => svc.noteAgentLifecycle('w', 'stopped'),
  'direct message': (svc) => svc.noteUserMessageToAgent('w', 'use b'),
  'answered in chat': (svc) => (svc as any).noteQuestionAnsweredInChat('w', 'use b', 0),
};

const worker = (c: Ctx, spawnedBy?: string) =>
  c.mk('w', 'Reviewer', { role: 'agent', agentType: 'reviewer', mission: 'review PR 9', ...(spawnedBy ? { spawnedBy, spawnDepth: 1 } : {}) });

afterEach(() => { vi.restoreAllMocks(); });

describe('a worker reports to the thread that started it', () => {
  for (const [kind, run] of Object.entries(fire)) {
    it(`${kind}: a worker a plain thread started reports to that thread, never to the overseer`, () => {
      const c = makeService();
      worker(c, 'u');
      run(c.svc);
      expect(c.to('u')).toHaveLength(1);
      expect(c.to('u')[0]).toContain('"Reviewer"');
      expect(c.to('coord')).toHaveLength(0);
      expect(c.revived).not.toHaveBeenCalledWith('coord');
    });

    it(`${kind}: a worker the overseer started reports to the overseer`, () => {
      const c = makeService();
      worker(c, 'coord');
      run(c.svc);
      expect(c.to('coord')).toHaveLength(1);
      expect(c.to('u')).toHaveLength(0);
    });

    it(`${kind}: an old worker with no starter still reports to the overseer`, () => {
      const c = makeService();
      worker(c);
      run(c.svc);
      expect(c.to('coord')).toHaveLength(1);
      expect(c.to('u')).toHaveLength(0);
    });

    it(`${kind}: a worker an archived earlier overseer started reports to the current overseer`, () => {
      const c = makeService();
      c.mk('old', 'Old Control Plane', { role: 'coordinator' });
      terminalsDb.archive(c.db, 'old');
      worker(c, 'old');
      run(c.svc);
      expect(c.to('coord')).toHaveLength(1);
    });

    it(`${kind}: a starter that is not running is not revived, and gets nothing now`, () => {
      const c = makeService();
      worker(c, 'u');
      c.live.delete('u');
      const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
      run(c.svc);
      expect(c.sent).not.toHaveBeenCalled();
      expect(c.revived).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalled();
    });

    it(`${kind}: an archived starter gets nothing, and the overseer is not the fallback`, () => {
      const c = makeService();
      worker(c, 'u');
      terminalsDb.archive(c.db, 'u');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      run(c.svc);
      expect(c.sent).not.toHaveBeenCalled();
    });

    it(`${kind}: a starter that no longer exists gets nothing, and the overseer is not the fallback`, () => {
      const c = makeService();
      worker(c, 'gone-thread');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      run(c.svc);
      expect(c.sent).not.toHaveBeenCalled();
    });

    it(`${kind}: a thread that carries the Chat origin sends nothing to the overseer or a starter`, () => {
      const c = makeService();
      c.mk('chat', 'Chat thread', { role: 'agent', origin: 'endless', spawnDepth: 1 });
      c.mk('kid', 'Kid', { role: 'agent', origin: 'endless', spawnedBy: 'chat', spawnDepth: 2 });
      worker(c, 'kid');
      terminalsDb.writeConfigRaw(c.db, 'w', { role: 'agent', origin: 'endless', spawnedBy: 'kid', spawnDepth: 3 });
      run(c.svc);
      expect(c.sent).not.toHaveBeenCalled();
    });

    it(`${kind}: a child made before the origin went down reports to its starter, not the overseer`, () => {
      const c = makeService();
      c.mk('chat', 'Chat thread', { role: 'agent', origin: 'endless', spawnDepth: 1, transport: 'structured' });
      c.live.add('chat');
      worker(c, 'chat');
      run(c.svc);
      expect(c.to('chat')).toHaveLength(1);
      expect(c.to('coord')).toHaveLength(0);
    });
  }

  it('a question from a worker whose starter is gone is not swallowed: it falls back to the human', () => {
    const c = makeService();
    worker(c, 'u');
    c.live.delete('u');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(c.svc.routeAgentQuestionToCoordinator('w', QUESTION)).toBe(false);
  });

  it('a question from a worker a plain thread started reaches the starter but stays visible to the human', () => {
    const c = makeService();
    worker(c, 'u');
    expect(c.svc.routeAgentQuestionToCoordinator('w', QUESTION)).toBe(false);
    expect(c.to('u')).toHaveLength(1);
  });

  it('a question from a worker the overseer started is taken off the human', () => {
    const c = makeService();
    worker(c, 'coord');
    expect(c.svc.routeAgentQuestionToCoordinator('w', QUESTION)).toBe(true);
  });

  it('the starter notice carries no Batch line and arms no interim timer on the overseer', () => {
    const c = makeService();
    worker(c, 'u');
    c.mk('other', 'Other', { role: 'agent', spawnedBy: 'coord', spawnDepth: 1 });
    terminalsDb.updateStatus(c.db, 'other', 'working');
    c.svc.noteAgentCompletion('w');
    expect(c.to('u')[0]).not.toContain('Batch:');
    expect(JSON.parse(terminalsDb.getById(c.db, 'coord')!.config!).interimDueAt).toBeUndefined();
  });

  it('a CLI (PTY) starter that is running gets the notice typed in and submitted', () => {
    const c = makeService();
    c.mk('cli', 'CLI thread', {});
    c.pty.alive.add('cli');
    worker(c, 'cli');
    c.svc.noteAgentCompletion('w');
    expect(c.pty.writes).toHaveLength(1);
    expect(c.pty.writes[0].id).toBe('cli');
    expect(c.pty.writes[0].data).toContain('just finished a turn');
    expect(c.sent).not.toHaveBeenCalled();
  });

  it('a CLI (PTY) starter that is not running is not written to', () => {
    const c = makeService();
    c.mk('cli', 'CLI thread', {});
    worker(c, 'cli');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    c.svc.noteAgentCompletion('w');
    expect(c.pty.writes).toHaveLength(0);
    expect(c.sent).not.toHaveBeenCalled();
  });
});

// The delivery outbox (engineering program W2-C): a notice that cannot be delivered now is kept and
// delivered on an event of its target. Before, it was logged and lost.
describe('a notice waits in the delivery outbox', () => {
  const rows = (c: Ctx, id: string) => c.svc.deliveryOutbox.list({ terminalId: id });

  it('a Finished notice for a coordinator that is not running is delivered after its next process start', () => {
    const c = makeService();
    worker(c, 'u');
    c.live.delete('u');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    c.svc.noteAgentCompletion('w');
    expect(c.to('u')).toHaveLength(0);
    expect(rows(c, 'u')).toMatchObject([{ state: 'pending', kind: 'notice', source_terminal_id: 'w', attempts: 0 }]);

    c.live.add('u'); // the process started
    expect(c.svc.deliveryOutbox.flush('u')).toBe(1); // what the process.started event does (delivery/wiring.ts)
    expect(c.to('u')).toHaveLength(1);
    expect(c.to('u')[0]).toContain('just finished a turn');
    expect(rows(c, 'u')).toMatchObject([{ state: 'delivered' }]);
    c.svc.deliveryOutbox.flush('u'); // a later event of the same thread
    expect(c.to('u')).toHaveLength(1);
    expect(c.revived).not.toHaveBeenCalled(); // the outbox never started the starter
  });

  it('a notice for the overseer that cannot start is kept, and delivered when it can', () => {
    const c = makeService();
    worker(c, 'coord');
    c.live.delete('coord');
    c.revived.mockReturnValue(false); // the overseer could not be started
    c.sent.mockImplementationOnce(() => { throw new Error('could not start the thread: spawn ENOENT'); });
    c.svc.noteAgentCompletion('w');
    expect(rows(c, 'coord')).toMatchObject([{ state: 'pending', attempts: 0 }]); // it waits; this is not a failed attempt
    c.live.add('coord');
    c.svc.deliveryOutbox.flush('coord');
    expect(rows(c, 'coord')).toMatchObject([{ state: 'delivered' }]);
    expect(String(c.sent.mock.calls.at(-1)![1])).toContain('Batch:');
  });

  it('the overseer is still revived for a notice, as before', () => {
    const c = makeService();
    worker(c, 'coord');
    c.live.delete('coord');
    c.svc.noteAgentCompletion('w');
    expect(c.revived).toHaveBeenCalledWith('coord');
    expect(c.to('coord')).toHaveLength(1);
    expect(rows(c, 'coord')).toMatchObject([{ state: 'delivered' }]);
  });

  it('a send that throws is kept and tried again on the next event', () => {
    const c = makeService();
    worker(c, 'coord');
    c.sent.mockImplementationOnce(() => { throw new Error('no structured session for terminal'); });
    c.svc.noteAgentCompletion('w');
    expect(rows(c, 'coord')).toMatchObject([{ state: 'pending', attempts: 1, last_error: 'no structured session for terminal' }]);
    c.svc.deliveryOutbox.flush('coord');
    expect(rows(c, 'coord')).toMatchObject([{ state: 'delivered' }]);
    expect(c.sent.mock.results.map((r) => r.type)).toEqual(['throw', 'return']); // one failed try, one delivery
    c.svc.deliveryOutbox.flush('coord');
    expect(c.sent).toHaveBeenCalledTimes(2);
  });

  it('a notice for an archived coordinator is dropped with a reason', () => {
    const c = makeService();
    worker(c, 'u');
    terminalsDb.archive(c.db, 'u');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    c.svc.noteAgentCompletion('w');
    expect(rows(c, 'u')).toMatchObject([{ state: 'dropped', last_error: 'the target is archived or removed' }]);
    expect(c.sent).not.toHaveBeenCalled();
  });

  it('a pending notice is dropped when its starter is archived before it runs again', () => {
    const c = makeService();
    worker(c, 'u');
    c.live.delete('u');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    c.svc.noteAgentCompletion('w');
    terminalsDb.archive(c.db, 'u');
    c.svc.deliveryOutbox.flush('u');
    expect(rows(c, 'u')).toMatchObject([{ state: 'dropped', last_error: 'the target is archived or removed' }]);
  });

  it('a PTY starter that is not running gets the notice typed in after it runs again', () => {
    const c = makeService();
    c.mk('cli', 'CLI thread', {});
    worker(c, 'cli');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    c.svc.noteAgentCompletion('w');
    expect(c.pty.writes).toHaveLength(0);
    c.pty.alive.add('cli');
    c.svc.deliveryOutbox.flush('cli');
    expect(c.pty.writes).toHaveLength(1);
    expect(c.pty.writes[0].data).toContain('just finished a turn');
  });

  it('a question that cannot be delivered now is not kept: the user gets it instead', () => {
    const c = makeService();
    worker(c, 'u');
    c.live.delete('u');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(c.svc.routeAgentQuestionToCoordinator('w', QUESTION)).toBe(false);
    expect(rows(c, 'u')).toMatchObject([{ state: 'dropped', kind: 'question' }]);
    c.live.add('u');
    c.svc.deliveryOutbox.flush('u');
    expect(c.to('u')).toHaveLength(0); // no stale question later
  });

  it('two notices of one worker are two rows when no lifecycle record tells them apart', () => {
    const c = makeService();
    worker(c, 'u');
    c.svc.noteUserMessageToAgent('w', 'use b');
    c.svc.noteUserMessageToAgent('w', 'use b');
    expect(c.to('u')).toHaveLength(2);
  });

  it('the same settle event enqueues one row', () => {
    const c = makeService();
    worker(c, 'u');
    // What StatusService.accept records for the turn.completed event of the worker.
    c.db.prepare(`INSERT INTO thread_lifecycle(terminal_id, status, source, observed_at, generation, sequence) VALUES ('w', 'waiting', 'authoritative', ?, 'gen-1', 7)`)
      .run(new Date().toISOString());
    c.svc.noteAgentCompletion('w');
    c.svc.noteAgentCompletion('w'); // the same event, handled twice
    expect(c.to('u')).toHaveLength(1);
    expect(rows(c, 'u')).toHaveLength(1);
    expect(rows(c, 'u')[0].dedup_key).toBe('notice:w:finished:gen-1:7');
    // The next turn of the worker has a new sequence: a new notice.
    c.db.prepare("UPDATE thread_lifecycle SET sequence = 12 WHERE terminal_id = 'w'").run();
    c.svc.noteAgentCompletion('w');
    expect(c.to('u')).toHaveLength(2);
  });
});

describe('owner-decisions capture', () => {
  const block = '```owner-decisions\n[{"id":"d1","question":"Ship it?","kind":"go"}]\n```';
  it('captures only for a worker the overseer started', () => {
    const c = makeService();
    worker(c, 'coord');
    vi.spyOn((c.svc as any).notifier, 'lastTurnTexts').mockReturnValue([block]);
    const capture = vi.spyOn((c.svc as any).notifier, 'captureOwnerDecisions');
    c.svc.noteAgentCompletion('w');
    expect(capture).toHaveBeenCalledTimes(1);
  });
  it('leaves the block in the report to the starter for any other worker', () => {
    const c = makeService();
    worker(c, 'u');
    vi.spyOn((c.svc as any).notifier, 'lastTurnTexts').mockReturnValue([block]);
    const capture = vi.spyOn((c.svc as any).notifier, 'captureOwnerDecisions');
    c.svc.noteAgentCompletion('w');
    expect(capture).not.toHaveBeenCalled();
    expect(ledgerDb.listBySession(c.db, 's1')).toHaveLength(0);
  });
  it('captures for an old worker with no starter', () => {
    const c = makeService();
    worker(c);
    const capture = vi.spyOn((c.svc as any).notifier, 'captureOwnerDecisions');
    c.svc.noteAgentCompletion('w');
    expect(capture).toHaveBeenCalledTimes(1);
  });
});

describe('batch line and interim recap count only overseer workers', () => {
  const state = (c: Ctx) => computeBatchState(c.db, 's1', {}, () => false);
  it('leaves out a worker that a plain thread started, and keeps the overseer and old ones', () => {
    const c = makeService();
    c.mk('mine', 'Mine', { role: 'agent', spawnedBy: 'coord', spawnDepth: 1 });
    c.mk('old', 'Old', { role: 'agent' });
    c.mk('theirs', 'Theirs', { role: 'agent', spawnedBy: 'u', spawnDepth: 1 });
    for (const id of ['mine', 'old', 'theirs']) terminalsDb.updateStatus(c.db, id, 'working');
    expect(state(c).working.map((r) => r.id).sort()).toEqual(['mine', 'old']);
  });
  it('leaves out a grandchild of a plain thread and a child of a Chat thread', () => {
    const c = makeService();
    c.mk('kid', 'Kid', { role: 'agent', spawnedBy: 'u', spawnDepth: 1 });
    c.mk('grand', 'Grand', { role: 'agent', spawnedBy: 'kid', spawnDepth: 2 });
    c.mk('chat', 'Chat', { role: 'agent', origin: 'endless', spawnDepth: 1 });
    c.mk('chatkid', 'Chat kid', { role: 'agent', spawnedBy: 'chat', spawnDepth: 2 });
    for (const id of ['kid', 'grand', 'chat', 'chatkid']) terminalsDb.updateStatus(c.db, id, 'working');
    expect(state(c).working).toEqual([]);
  });
  it('keeps a worker a still-existing earlier overseer started', () => {
    const c = makeService();
    c.mk('old', 'Old CP', { role: 'coordinator' });
    terminalsDb.archive(c.db, 'old');
    c.mk('w2', 'W2', { role: 'agent', spawnedBy: 'old', spawnDepth: 1 });
    terminalsDb.updateStatus(c.db, 'w2', 'working');
    expect(state(c).working.map((r) => r.id)).toEqual(['w2']);
  });
});

describe('interim recap', () => {
  it('does not fire for a batch made only of workers other threads started', () => {
    const c = makeService();
    terminalsDb.writeConfigRaw(c.db, 'coord', { role: 'coordinator', interimDueAt: new Date(0).toISOString() });
    c.mk('theirs', 'Theirs', { role: 'agent', spawnedBy: 'u', spawnDepth: 1 });
    terminalsDb.updateStatus(c.db, 'theirs', 'working');
    ledgerDb.create(c.db, { sessionId: 's1', kind: 'decide', text: 'Which?', author: 'overseer' });
    const notice = vi.spyOn(c.svc, 'sendInterimRecapNotice').mockReturnValue(true);
    expect(interimRecapTick(c.db, c.svc, Date.now())).toEqual([]);
    expect(notice).not.toHaveBeenCalled();
    expect(JSON.parse(terminalsDb.getById(c.db, 'coord')!.config!).interimDueAt).toBeUndefined();
  });
});
