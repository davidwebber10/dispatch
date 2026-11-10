// CoordinatorNotifier alone: built from its typed inputs, with no SessionService.
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { ThreadConfigStore } from './thread-config.js';
import { ThreadTranscripts } from './thread-transcripts.js';
import { DeliveryOutbox } from '../delivery/outbox.js';
import { LedgerService } from '../overseer/ledger-service.js';
import { computeBatchState } from './batch-state.js';
import { CoordinatorNotifier, type CoordinatorNotifierDeps } from './coordinator-notifier.js';

function make(over: Partial<CoordinatorNotifierDeps['threads']> = {}) {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
  terminalsDb.create(db, { id: 'a', sessionId: 's1', type: 'claude-code', label: 'Worker', config: { role: 'agent', mission: 'fix login' } });
  const sent: [string, string][] = [];
  const started: [string, string | undefined, unknown][] = [];
  const revived: string[] = [];
  const typed: [string, string][] = [];
  const livePty = new Set<string>();
  let outbox: DeliveryOutbox;
  const ledger = new LedgerService(db, { clock: () => 1_700_000_000_000 });
  const notifier: CoordinatorNotifier = new CoordinatorNotifier({
    db,
    configStore: new ThreadConfigStore(db),
    pty: { isAlive: (id) => livePty.has(id), write: (id, data) => { typed.push([id, data]); } },
    transcripts: new ThreadTranscripts(db),
    clock: () => 1_700_000_000_000,
    outbox: () => outbox,
    ledger: () => ledger,
    threads: {
      structuredManagerForTerminal: () => undefined,
      isStructuredTerminal: () => false,
      ensureStructuredAlive: (id) => { revived.push(id); return true; },
      sendStructuredMessage: (id, content) => { sent.push([id, String(content)]); },
      startQueuedTerminal: (id, task, opts) => { started.push([id, task, opts]); return terminalsDb.rowToTerminal(terminalsDb.getById(db, id)!); },
      getPendingPermission: () => null,
      batchState: (sessionId, opts) => computeBatchState(db, sessionId, opts ?? {}, () => false),
      ...over,
    },
  });
  outbox = new DeliveryOutbox({ db, now: () => 1_700_000_000_000, deliver: (id, body, kind) => notifier.deliverOutboxRow(id, body, kind) });
  const rows = () => db.prepare('SELECT target_terminal_id AS target, source_terminal_id AS source, kind, state FROM delivery_outbox ORDER BY id').all();
  return { db, notifier, sent, started, revived, typed, livePty, rows };
}

describe('CoordinatorNotifier', () => {
  it('a completed agent enqueues one Finished notice for its starter', () => {
    const c = make();
    c.notifier.noteAgentCompletion('a');
    expect(c.rows()).toEqual([{ target: 'coord', source: 'a', kind: 'notice', state: 'delivered' }]);
    expect(c.sent.length).toBe(1);
    expect(c.sent[0][0]).toBe('coord');
    expect(c.sent[0][1]).toContain('✅ Your agent "Worker" (mission "fix login") [agentId a] just finished a turn.');
    expect(c.revived).toEqual(['coord']); // the overseer is started when a restart killed it
  });

  it('a queued dependent starts when its dependency is done', () => {
    const c = make();
    terminalsDb.create(c.db, { id: 'dep', sessionId: 's1', type: 'claude-code', label: 'Review', config: { role: 'agent', dependsOn: 'a', queued: true, queuedTask: 'review it' } });
    terminalsDb.updateStatus(c.db, 'dep', 'queued');
    terminalsDb.create(c.db, { id: 'other', sessionId: 's1', type: 'claude-code', label: 'Other', config: { role: 'agent', dependsOn: 'zzz', queued: true, queuedTask: 'x' } });
    terminalsDb.updateStatus(c.db, 'other', 'queued');
    c.notifier.noteAgentCompletion('a');
    expect(c.started.map(([id]) => id)).toEqual(['dep']);
    expect(c.started[0][1]).toContain('The agent you were waiting on ("Worker") has finished.');
    expect(String(c.started[0][1]).endsWith('review it')).toBe(true);
    expect(c.started[0][2]).toEqual({ enforceCap: false });
  });

  it('the same turn end makes one outbox row: a second call with the same lifecycle position is a duplicate', () => {
    const c = make();
    c.db.prepare("INSERT INTO thread_lifecycle (terminal_id, status, generation, sequence) VALUES ('a', 'waiting', 'g1', 4)").run();
    c.notifier.noteAgentCompletion('a');
    c.notifier.noteAgentCompletion('a');
    expect(c.rows().length).toBe(1);
    expect(c.sent.length).toBe(1);
  });

  it('a starter that is not the overseer is never started for a notice: the row waits', () => {
    const c = make();
    terminalsDb.create(c.db, { id: 'starter', sessionId: 's1', type: 'claude-code', label: 'Starter' });
    terminalsDb.create(c.db, { id: 'w', sessionId: 's1', type: 'claude-code', label: 'W', config: { role: 'agent', spawnedBy: 'starter' } });
    c.notifier.noteAgentNeedsHelp('w', 'which branch?');
    expect(c.rows()).toEqual([{ target: 'starter', source: 'w', kind: 'notice', state: 'pending' }]);
    expect(c.revived).toEqual([]);
    expect(c.sent).toEqual([]);
    expect(c.typed).toEqual([]);
  });

  it('a question that the overseer cannot take now is not kept: the caller gives it to the user', () => {
    const c = make({ sendStructuredMessage: () => { throw new Error('no structured session for terminal'); } });
    const routed = c.notifier.routeAgentQuestionToCoordinator('a', { toolName: 'AskUserQuestion', questions: [{ header: 'H', question: 'Q?', options: ['y'] }] });
    expect(routed).toBe(false);
    expect((c.rows() as { state: string }[]).every((r) => r.state !== 'pending')).toBe(true);
  });

  it('the outcome of a role run keeps 4000 characters of summary; any other thread keeps 400', () => {
    const c = make();
    terminalsDb.create(c.db, { id: 'run', sessionId: 's1', type: 'claude-code', label: 'Run', config: { roleRun: 'r1' } });
    c.notifier.noteTurnOutcome('a', { summary: 'x'.repeat(5000), needsHelp: false, inferred: false });
    c.notifier.noteTurnOutcome('run', { summary: 'x'.repeat(5000), needsHelp: true, inferred: false, state: 'blocked', blocker: 'no token' });
    const cfg = (id: string) => JSON.parse(terminalsDb.getById(c.db, id)!.config || '{}');
    expect(cfg('a').lastOutcome.summary.length).toBe(400);
    expect(cfg('a').mission).toBe('fix login');
    expect(cfg('run').lastOutcome.summary.length).toBe(4000);
    expect(cfg('run').lastOutcome.blocker).toBe('no token');
  });
});
