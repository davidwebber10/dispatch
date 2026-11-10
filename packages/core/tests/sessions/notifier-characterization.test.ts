// W3-B characterization: the notices of SessionService, recorded through the facade before the
// code moved to CoordinatorNotifier. The facade must do the same after the move.
import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';

class FakePty extends PTYManager {
  live = new Set<string>();
  written: [string, string][] = [];
  override spawn(): number { return 1; }
  override write(id: string, data: string): void { this.written.push([id, data]); }
  override resize(): void {}
  override kill(): void {}
  override getBuffer(): string { return ''; }
  override isAlive(id: string): boolean { return this.live.has(id); }
  override killAll(): void {}
}

function make() {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  const pty = new FakePty();
  const svc = new SessionService(db, pty, '/tmp/dispatch-notifier-char-mcp.json');
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
  terminalsDb.create(db, { id: 'a', sessionId: 's1', type: 'claude-code', label: 'Worker', config: { role: 'agent', mission: 'fix login' } });
  const revived = vi.spyOn(svc, 'ensureStructuredAlive').mockReturnValue(true);
  const sent = vi.spyOn(svc, 'sendStructuredMessage').mockImplementation(() => {});
  const outboxRows = () => db.prepare('SELECT target_terminal_id AS target_id, source_terminal_id AS source_id, kind, state FROM delivery_outbox ORDER BY id').all() as { target_id: string; source_id: string; kind: string; state: string }[];
  return { db, pty, svc, sent, revived, outboxRows };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('SessionService notices (characterization)', () => {
  it('a completed agent sends one Finished notice to the overseer, through one delivered outbox row', () => {
    const c = make();
    c.svc.noteAgentCompletion('a');
    expect(c.sent).toHaveBeenCalledTimes(1);
    expect(c.sent.mock.calls[0][0]).toBe('coord');
    const text = String(c.sent.mock.calls[0][1]);
    expect(text.startsWith('✅ Your agent "Worker" (mission "fix login") [agentId a] just finished a turn.\n')).toBe(true);
    expect(text).toContain('Batch: no other agent is working or queued.');
    expect(c.revived).toHaveBeenCalledWith('coord');
    expect(c.outboxRows()).toEqual([{ target_id: 'coord', source_id: 'a', kind: 'notice', state: 'delivered' }]);
  });

  it('a thread that is not an agent sends no notice when its turn ends', () => {
    const c = make();
    terminalsDb.create(c.db, { id: 'plain', sessionId: 's1', type: 'claude-code', label: 'Plain' });
    c.svc.noteAgentCompletion('plain');
    c.svc.noteAgentNeedsHelp('plain', 'help');
    c.svc.noteAgentLifecycle('plain', 'stopped');
    c.svc.noteUserMessageToAgent('plain', 'hello');
    expect(c.sent).not.toHaveBeenCalled();
    expect(c.outboxRows()).toEqual([]);
  });

  it('a queued dependent starts when its dependency is done, with the output of the dependency before its task', () => {
    const c = make();
    terminalsDb.create(c.db, { id: 'dep', sessionId: 's1', type: 'claude-code', label: 'Review', config: { role: 'agent', dependsOn: 'a', queued: true, queuedTask: 'review it' } });
    terminalsDb.updateStatus(c.db, 'dep', 'queued');
    const started: [string, string | undefined, unknown][] = [];
    vi.spyOn(c.svc, 'startQueuedTerminal').mockImplementation((id: string, task?: string, opts?: unknown) => { started.push([id, task, opts]); return c.svc.getTerminal(id); });
    c.svc.noteAgentCompletion('a');
    expect(started.length).toBe(1);
    expect(started[0][0]).toBe('dep');
    expect(started[0][1]).toContain('The agent you were waiting on ("Worker") has finished.');
    expect(started[0][1]).toContain('(no output captured)');
    expect(String(started[0][1]).endsWith('review it')).toBe(true);
    expect(started[0][2]).toEqual({ enforceCap: false });
  });

  it('a worker of another thread reports to that thread: typed into a live CLI starter, kept for a dead one, never to the overseer', () => {
    const c = make();
    terminalsDb.create(c.db, { id: 'starter', sessionId: 's1', type: 'claude-code', label: 'Starter' });
    terminalsDb.create(c.db, { id: 'w', sessionId: 's1', type: 'claude-code', label: 'W', config: { role: 'agent', spawnedBy: 'starter' } });
    c.svc.noteAgentCompletion('w');
    expect(c.outboxRows()).toEqual([{ target_id: 'starter', source_id: 'w', kind: 'notice', state: 'pending' }]);
    c.pty.live.add('starter');
    c.svc.noteAgentNeedsHelp('w', 'which branch?');
    // The notice that waited goes out with the next one, oldest first.
    expect(c.pty.written.map(([id]) => id)).toEqual(['starter', 'starter']);
    expect(c.pty.written[0][1]).toContain('just finished a turn');
    expect(c.pty.written[1][1]).toContain('is BLOCKED, waiting on you');
    expect(c.outboxRows().map((r) => r.state)).toEqual(['delivered', 'delivered']);
    expect(c.sent).not.toHaveBeenCalled();
  });

  it('a question of an agent goes to the overseer with the answer_agent call; a plain tool does not', () => {
    const c = make();
    expect(c.svc.routeAgentQuestionToCoordinator('a', { toolName: 'Bash' })).toBe(false);
    expect(c.svc.routeAgentQuestionToCoordinator('a', { toolName: 'AskUserQuestion', questions: [{ header: 'Fix', question: 'Stage it?', options: ['yes', 'no'] }] })).toBe(true);
    const text = String(c.sent.mock.calls[0][1]);
    expect(text).toContain('is PAUSED waiting on you');
    expect(text).toContain('answer_agent({ agentId: "a", answers: { "<header>": "<chosen option>" } })');
    expect(c.outboxRows()[0].kind).toBe('question');
  });

  it('the turn outcome is saved as one config key and keeps the other keys', () => {
    const c = make();
    c.svc.noteTurnOutcome('a', { summary: 'done it', needsHelp: false, inferred: true, state: 'done' });
    const cfg = c.svc.getTerminal('a')!.config as Record<string, any>;
    expect(cfg.role).toBe('agent');
    expect(cfg.mission).toBe('fix login');
    expect(cfg.lastOutcome).toMatchObject({ summary: 'done it', needsHelp: false, inferred: true, declaredState: 'done' });
  });

  it('the board state patch sets and clears its two fields', () => {
    const c = make();
    expect(c.svc.setBoardState('missing', { acknowledged: true })).toBe(false);
    expect(c.svc.setBoardState('a', { acknowledged: true, override: 'done' })).toBe(true);
    let board = (c.svc.getTerminal('a')!.config as Record<string, any>).boardState;
    expect(typeof board.acknowledgedAt).toBe('string');
    expect(board.override).toBe('done');
    c.svc.setBoardState('a', { acknowledged: false, override: null });
    board = (c.svc.getTerminal('a')!.config as Record<string, any>).boardState;
    expect(board.acknowledgedAt).toBeUndefined();
    expect(board.override).toBeNull();
  });

  it('an outbox row for a shell tab, an archived thread or a missing thread is gone; a dead CLI thread is not alive', () => {
    const c = make();
    terminalsDb.create(c.db, { id: 'sh', sessionId: 's1', type: 'shell', label: 'sh' });
    terminalsDb.create(c.db, { id: 'cli', sessionId: 's1', type: 'claude-code', label: 'cli' });
    expect(c.svc.deliverOutboxRow('sh', 'x', 'notice')).toBe('gone');
    expect(c.svc.deliverOutboxRow('missing', 'x', 'notice')).toBe('gone');
    expect(c.svc.deliverOutboxRow('cli', 'x', 'notice')).toBe('not-alive');
    c.pty.live.add('cli');
    expect(c.svc.deliverOutboxRow('cli', 'x', 'notice')).toBe('delivered');
    terminalsDb.archive(c.db, 'cli');
    expect(c.svc.deliverOutboxRow('cli', 'x', 'notice')).toBe('gone');
    expect(c.svc.deliverOutboxRow('coord', 'x', 'notice')).toBe('delivered');
    expect(c.sent).toHaveBeenCalledWith('coord', 'x');
  });
});
