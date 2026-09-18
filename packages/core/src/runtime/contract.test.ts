import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessions from '../db/sessions.js';
import * as terminals from '../db/terminals.js';
import { StatusService } from '../status/service.js';
import { subscribeHarnessEvents } from './adapter.js';
import type { HarnessEvent } from './events.js';
import { AGENT_TYPES } from '../providers/agent-types.js';
import { getProvider } from '../providers/registry.js';
import { migrate } from '../db/migrations.js';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); initSchema(db); sessions.create(db, { id: 'p', provider: 'claude-code', name: 'P', workingDir: '/tmp' }); });
afterEach(() => db.close());

function setup(provider: string) {
  terminals.create(db, { id: 't', sessionId: 'p', type: provider as any, label: provider });
  const manager = new EventEmitter(); const notify = vi.fn(); const broadcast = vi.fn();
  const status = new StatusService(db, { broadcast }); const events: HarnessEvent[] = [];
  const dispose = subscribeHarnessEvents(manager, () => provider, event => { events.push(event); status.accept(event, notify); });
  return { manager, status, notify, broadcast, events, dispose };
}
const turn = () => db.prepare('SELECT * FROM usage_turns ORDER BY rowid DESC LIMIT 1').get() as any;

describe.each(AGENT_TYPES)('%s shared harness contract', provider => {
  it('starts once, pauses for permission, resumes, and completes once before notifying', () => {
    const { manager, notify, status } = setup(provider);
    manager.emit('busy', 't'); manager.emit('busy', 't');
    expect((db.prepare('SELECT COUNT(*) n FROM usage_turns').get() as any).n).toBe(1);
    manager.emit('permission', 't', { toolName: 'Write' });
    expect(terminals.getById(db,'t')!.status).toBe('needs_input'); expect(turn().ended_at).toBeNull();
    manager.emit('resolved','t'); expect(terminals.getById(db,'t')!.status).toBe('working');
    notify.mockImplementation((e: HarnessEvent) => {
      if (e.type === 'turn.completed') { expect(turn().ended_at).not.toBeNull(); expect(terminals.getById(db,'t')!.status).toBe('waiting'); }
    });
    manager.emit('idle','t'); manager.emit('idle','t');
    expect(notify.mock.calls.filter(([e]) => e.type === 'turn.completed')).toHaveLength(1);
    expect(status.diagnostics('t').events).toEqual(expect.arrayContaining([expect.objectContaining({ disposition: 'turn-already-closed' })]));
  });
  it('handles cancellation/crash and rejects duplicate, stale-turn, and old-process events', () => {
    const { manager, status, events, dispose } = setup(provider);
    manager.emit('busy','t'); const oldStart = events.at(-1)!;
    manager.emit('failed','t'); expect(turn().outcome).toBe('error');
    manager.emit('busy','t'); const start = events.at(-1)!;
    expect(status.accept(start)).toBe(false);
    expect(status.accept({ ...start, type: 'turn.completed', outcome: 'idle', detail: {}, turnId: oldStart.turnId, sequence: start.sequence + 1 })).toBe(false);
    manager.emit('exit','t',1); expect(turn().outcome).toBe('error'); expect(terminals.getById(db,'t')!.status).toBe('error');
    dispose();
    const replacement = new EventEmitter(); subscribeHarnessEvents(replacement, () => provider, e => status.accept(e));
    replacement.emit('busy','t');
    expect(status.accept({ ...oldStart, type: 'turn.completed', outcome: 'idle', detail: {}, sequence: 1000 })).toBe(false);
    expect(status.accept(events[0])).toBe(false); // replayed old process-start cannot reactivate it
    expect(terminals.getById(db,'t')!.status).toBe('working');
  });
  it('normalizes usage at the boundary and keeps telemetry capability declarations explicit', () => {
    const { manager } = setup(provider); manager.emit('busy','t');
    manager.emit('event','t',{ type: 'assistant', message: { id: 'response', model: 'test', content: [], usage: { input_tokens: 10, output_tokens: 5 } } });
    manager.emit('event','t',{ type: 'assistant', message: { id: 'response', model: 'test', content: [], usage: { input_tokens: 10, output_tokens: 5 } } });
    manager.emit('idle','t'); expect(turn().input_tokens).toBe(10);
    expect(getProvider(provider).telemetry).toHaveProperty('ptyCapture');
  });
});

it('rolls back an entire multi-model event including checkpoints and exposes the failure', () => {
  const { manager, status, events, broadcast } = setup('codex'); manager.emit('busy','t');
  const start = events.at(-1)!; broadcast.mockClear();
  const m = (model: string) => ({ input: 10, output: 2, cacheRead: 0, cacheCreate: 0, model, source: 'structured' as const,
    counter: { key: model, initialIsDelta: true, totals: { input: 10, output: 2, cacheRead: 0, cacheCreate: 0 } } });
  db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON usage_facts WHEN NEW.model='second' BEGIN SELECT RAISE(ABORT,'second model failed'); END");
  const event: HarnessEvent = { ...start, type: 'usage.observed', eventId: 'batch', sequence: start.sequence + 1, measurements: [m('first'),m('second')] };
  expect(status.accept(event)).toBe(false);
  expect((db.prepare('SELECT COUNT(*) n FROM usage_facts').get() as any).n).toBe(0);
  expect((db.prepare('SELECT COUNT(*) n FROM usage_checkpoints').get() as any).n).toBe(0);
  expect(turn().coverage).toBe('partial'); expect(status.diagnostics('t').captureFailure).toMatchObject({ occurrences: 1 });
  expect(broadcast).not.toHaveBeenCalled();
  db.exec('DROP TRIGGER fail_second'); expect(status.accept(event)).toBe(true); expect(turn().input_tokens).toBe(20);
});
it('rolls back status, turn closure, and queued effects together', () => {
  const { manager, status, events, broadcast } = setup('codex'); manager.emit('busy','t');
  db.exec("CREATE TRIGGER fail_status BEFORE UPDATE OF status ON terminals WHEN NEW.status='waiting' BEGIN SELECT RAISE(ABORT,'status failed'); END");
  broadcast.mockClear(); const start = events.at(-1)!;
  expect(status.accept({ ...start, type: 'turn.completed', outcome: 'idle', detail: {}, sequence: start.sequence+1 })).toBe(false);
  expect(turn().ended_at).toBeNull(); expect(terminals.getById(db,'t')!.status).toBe('working'); expect(broadcast).not.toHaveBeenCalled();
});
it('bounds diagnostics without storing prompt content', () => {
  const { status } = setup('codex'); for (let n=0;n<240;n++) status.markWorking('t', 'secret prompt text');
  expect(status.diagnostics('t').events).toHaveLength(200);
  expect(JSON.stringify(status.diagnostics('t'))).not.toContain('secret prompt text');
});
it('migration failures roll back and remain retryable', () => {
  expect(() => migrate(db,'test-failure',() => { db.exec('CREATE TABLE should_rollback (id TEXT)'); throw new Error('fail'); })).toThrow('fail');
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='should_rollback'").get()).toBeUndefined();
  expect(db.prepare("SELECT id FROM schema_migrations WHERE id='test-failure'").get()).toBeUndefined();
  migrate(db,'test-failure',() => db.exec('CREATE TABLE should_rollback (id TEXT)'));
  expect(db.prepare("SELECT id FROM schema_migrations WHERE id='test-failure'").get()).toBeDefined();
});

it('a completion-triggered next turn cannot be overwritten by delayed idle broadcasts', () => {
  terminals.create(db,{ id: 't', sessionId: 'p', type: 'codex', label: 'T' });
  const manager = new EventEmitter(); const statuses: string[] = [];
  const status = new StatusService(db,{ broadcast: e => { if (e.type === 'terminal:status') statuses.push((e as any).status); } },undefined,
    (_id, state) => { if (state === 'idle') manager.emit('busy','t'); });
  subscribeHarnessEvents(manager,() => 'codex',event => status.accept(event));
  manager.emit('busy','t'); manager.emit('idle','t');
  expect(statuses).toEqual(['working','waiting','working']);
  expect(terminals.getById(db,'t')!.status).toBe('working');
  expect(turn().ended_at).toBeNull();
});
