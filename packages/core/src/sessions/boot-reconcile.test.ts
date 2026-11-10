// Durable boot recovery (engineering program W2-C): a scheduled wake that the restart killed is
// flagged, and a question a thread waited on is shown again. Each "daemon" is a new set of
// services on the same database file.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import * as parksDb from '../db/usage-limits.js';
import * as pendingQuestionsDb from '../db/pending-questions.js';
import { SessionService } from './service.js';
import { StatusService } from '../status/service.js';
import { PTYManager } from '../pty/manager.js';
import { subscribeHarnessEvents } from '../runtime/adapter.js';
import { DeliveryOutbox } from '../delivery/outbox.js';
import { reconcileAtBoot, wireRestoredQuestions, LOST_WAKE_ACTIVITY } from './boot-reconcile.js';
import type { IStructuredManager, PendingPermission } from '../structured/manager.js';

class FakePty extends PTYManager {
  alive = new Set<string>();
  override spawn(): number { return 1; }
  override write(): void {}
  override resize(): void {}
  override kill(): void {}
  override getBuffer(): string { return ''; }
  override isAlive(id: string): boolean { return this.alive.has(id); }
  override killAll(): void {}
}

class FakeStructured extends EventEmitter {
  live = new Set<string>();
  pending = new Map<string, PendingPermission>();
  sent: { id: string; content: unknown; source?: string }[] = [];
  spawns: string[] = [];
  setDefaultEnv() {}
  spawn(id: string) { this.live.add(id); this.spawns.push(id); return 4321; }
  sendMessage(id: string, content: unknown, source?: string) { this.sent.push({ id, content, source }); this.emit('busy', id); }
  /** The model asks: what the real manager does on an AskUserQuestion control request. */
  ask(id: string, p: PendingPermission) { this.pending.set(id, p); this.emit('permission', id, p); }
  answerPermission(id: string) { if (!this.pending.delete(id)) return false; this.emit('resolved', id); this.emit('permission-cleared', id); return true; }
  getPending(id: string) { return this.pending.get(id) ?? null; }
  getSessionId() { return undefined; }
  getEvents() { return []; }
  getEventsTail() { return []; }
  getTurnTexts(): string[] | null { return null; }
  isAlive(id: string) { return this.live.has(id); }
  kill(id: string) { this.live.delete(id); }
  killAll() { this.live.clear(); }
}

const QUESTION: PendingPermission = {
  requestId: 'req-1',
  toolName: 'AskUserQuestion',
  input: { questions: [{ header: 'Branch', question: 'Which branch do I use?', options: [{ label: 'main' }, { label: 'release' }] }] },
  questions: [{ header: 'Branch', question: 'Which branch do I use?', options: [{ label: 'main' }, { label: 'release' }] }],
};

let dir: string;
let dbPath: string;

function boot() {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);
  const pty = new FakePty();
  const svc = new SessionService(db, pty, path.join(dir, 'mcp.json'));
  const manager = new FakeStructured();
  svc.setStructuredManager(manager as unknown as IStructuredManager);
  svc.setStructuredCommandOverride({ command: 'fake', args: [] });
  const broadcast = vi.fn();
  const status = new StatusService(db, { broadcast });
  const outbox = new DeliveryOutbox({ db, deliver: (id, body, kind) => svc.deliverOutboxRow(id, body, kind) });
  svc.setDeliveryOutbox(outbox);
  subscribeHarnessEvents(manager, (id) => (db.open ? terminalsDb.getById(db, id)?.type : undefined), (event) => { status.accept(event); });
  wireRestoredQuestions(db, svc, [manager as unknown as IStructuredManager], status);
  const isAlive = (id: string) => pty.isAlive(id) || manager.isAlive(id);
  /** The boot `finally` block of server.ts, in its order. */
  const recover = () => {
    const result = reconcileAtBoot({ db, isAlive, markIdle: (id, activity) => status.markIdle(id, activity), outbox });
    const waiting = new Set(result.restoredQuestions);
    status.reconcileProcesses((id) => isAlive(id) || waiting.has(id));
    return result;
  };
  const statusOf = (id: string) => terminalsDb.getById(db, id)?.status;
  const events = (id: string, type: string) => db.prepare('SELECT * FROM lifecycle_events WHERE terminal_id = ? AND event_type = ?').all(id, type);
  return { db, pty, svc, manager, status, outbox, broadcast, recover, statusOf, events, isAlive };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-reconcile-'));
  dbPath = path.join(dir, 'dispatch.db');
  const db = new Database(dbPath);
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: dir });
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { transport: 'structured', role: 'coordinator' } });
  terminalsDb.create(db, { id: 'lead', sessionId: 's1', type: 'claude-code', label: 'Lead', config: { transport: 'structured' } });
  terminalsDb.create(db, { id: 't', sessionId: 's1', type: 'claude-code', label: 'Poller', config: { transport: 'structured' } });
  db.close();
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('reconcileAtBoot: lost wakes', () => {
  /** A daemon that ran its boot check: every real daemon does, right after it starts. */
  function started() { const d = boot(); d.recover(); return d; }
  /** A thread ends its turn with ScheduleWakeup: the wake lives in its process. */
  function schedule(d: ReturnType<typeof boot>, id = 't') {
    d.manager.live.add(id);
    d.manager.emit('busy', id);
    d.manager.emit('scheduled', id, 'Scheduled — check the deploy');
    expect(d.statusOf(id)).toBe('scheduled');
  }

  it('a scheduled thread with a dead process becomes idle with the lost-wake text and one lifecycle event', () => {
    schedule(started());
    const d = boot(); // the restart: the process and its wake are gone
    const result = d.recover();
    expect(result.lostWakes).toEqual(['t']);
    expect(d.statusOf('t')).toBe('waiting');
    expect(d.events('t', 'wake.lost')).toHaveLength(1);
    expect(d.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal:status', terminalId: 't', threadStatus: 'idle', activity: LOST_WAKE_ACTIVITY }));
    expect(LOST_WAKE_ACTIVITY).toBe('A scheduled wake was lost when Dispatch restarted');
    expect(d.manager.spawns).toEqual([]); // it does not restart the thread
    // A second boot finds nothing more to flag.
    expect(boot().recover().lostWakes).toEqual([]);
    expect(d.events('t', 'wake.lost')).toHaveLength(1);
  });

  it('a scheduled thread whose process is alive is left alone', () => {
    const d = boot();
    schedule(d);
    expect(d.recover().lostWakes).toEqual([]);
    expect(d.statusOf('t')).toBe('scheduled');
    expect(d.events('t', 'wake.lost')).toHaveLength(0);
  });

  it('a thread that waits for a usage limit is not a lost wake: the daemon resumes it itself', () => {
    const first = started();
    schedule(first);
    const now = Date.now();
    parksDb.upsert(first.db, { terminal_id: 't', provider: 'claude-code', kind: 'session', resets_at: now + 3600_000, wake_at: now + 3600_000, message: 'limit', parsed: 1, attempts: 0, state: 'parked', parked_at: now }, now);
    const d = boot();
    expect(d.recover().lostWakes).toEqual([]);
    expect(d.statusOf('t')).toBe('scheduled');
  });

  it('an archived scheduled thread is left alone', () => {
    const first = started();
    schedule(first);
    terminalsDb.archive(first.db, 't');
    expect(boot().recover().lostWakes).toEqual([]);
  });

  it('the starter of a worker gets one lost-wake notice when it runs again; it is not started for it', () => {
    const first = started();
    terminalsDb.writeConfigRaw(first.db, 't', { transport: 'structured', role: 'agent', spawnedBy: 'lead', spawnDepth: 1 });
    schedule(first);
    const d = boot();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    d.recover();
    expect(d.outbox.list({ terminalId: 'lead' })).toMatchObject([{ kind: 'lost-wake', state: 'pending', source_terminal_id: 't' }]);
    expect(d.manager.spawns).toEqual([]);
    d.manager.live.add('lead');
    d.outbox.flush('lead');
    const got = d.manager.sent.filter((s) => s.id === 'lead');
    expect(got).toHaveLength(1);
    expect(String(got[0].content)).toContain('"Poller"');
    expect(String(got[0].content)).toContain('scheduled wake was lost');
  });

  it('a worker the overseer started reports its lost wake to the overseer', () => {
    const first = started();
    terminalsDb.writeConfigRaw(first.db, 't', { transport: 'structured', role: 'agent', spawnedBy: 'coord', spawnDepth: 1 });
    schedule(first);
    const d = boot();
    d.recover();
    expect(d.outbox.list({ terminalId: 'coord' })).toMatchObject([{ kind: 'lost-wake', state: 'delivered' }]);
    expect(d.manager.sent.filter((s) => s.id === 'coord')).toHaveLength(1);
  });

  // v4.5.0 review, I7: the check had no age limit. The first boot of the version that has it found every thread that
  // an earlier version left `scheduled` (weeks of them), and each worker among them made a lost-wake notice that
  // started its coordinator and a turn.
  it('the first boot after the upgrade leaves the old scheduled threads as they are: no event, no notice, no coordinator turn', () => {
    const old = boot(); // the version before: it never ran this check
    terminalsDb.create(old.db, { id: 'w2', sessionId: 's1', type: 'claude-code', label: 'Old worker', config: { transport: 'structured', role: 'agent', spawnedBy: 'lead', spawnDepth: 1 } });
    terminalsDb.writeConfigRaw(old.db, 't', { transport: 'structured', role: 'agent', spawnedBy: 'coord', spawnDepth: 1 });
    schedule(old, 't');
    schedule(old, 'w2');
    // They went dormant a week ago (the test runs in one millisecond; the real backlog is old).
    old.db.prepare('UPDATE thread_lifecycle SET observed_at = ? WHERE terminal_id IN (?, ?)').run(new Date(Date.now() - 7 * 86_400_000).toISOString(), 't', 'w2');
    const d = boot(); // the first start of the new version
    const result = d.recover();
    expect(result.lostWakes).toEqual([]);
    expect(d.statusOf('t')).toBe('scheduled');
    expect(d.statusOf('w2')).toBe('scheduled');
    expect(d.events('t', 'wake.lost')).toHaveLength(0);
    expect(d.outbox.list({})).toEqual([]);
    expect(d.manager.spawns).toEqual([]); // no coordinator was started
    expect(d.manager.sent).toEqual([]);   // and none got a turn
    // A thread that schedules a wake under the new version is flagged at the next start. The old ones still are not.
    terminalsDb.create(d.db, { id: 'n', sessionId: 's1', type: 'claude-code', label: 'New poller', config: { transport: 'structured' } });
    schedule(d, 'n');
    const next = boot();
    expect(next.recover().lostWakes).toEqual(['n']);
    expect(next.statusOf('n')).toBe('waiting');
    expect(next.statusOf('t')).toBe('scheduled');
    expect(next.outbox.list({})).toEqual([]);
    expect(boot().recover().lostWakes).toEqual([]);
  });

  it('a daemon that stopped before its boot check ended does not hide the wakes that the daemon before it lost', () => {
    schedule(started());
    boot(); // a start that died before the check
    expect(boot().recover().lostWakes).toEqual(['t']);
  });

  it('a plain thread with no starter is flagged with no notice', () => {
    schedule(started());
    const d = boot();
    expect(d.recover().lostWakes).toEqual(['t']);
    expect(d.outbox.list({})).toEqual([]);
  });
});

describe('pending questions survive a restart', () => {
  /** A thread asks a question and waits. */
  function ask(d: ReturnType<typeof boot>, id = 't', q = QUESTION) {
    d.manager.live.add(id);
    d.manager.emit('busy', id);
    d.manager.ask(id, q);
    expect(d.statusOf(id)).toBe('needs_input');
  }

  it('a saved question is returned by getPendingPermission after a restart', () => {
    const first = boot();
    ask(first);
    expect(pendingQuestionsDb.get(first.db, 't')).toMatchObject({ request_id: 'req-1' });

    const d = boot(); // nothing in the new manager's memory
    expect(d.manager.getPending('t')).toBeNull();
    const result = d.recover();
    expect(result.restoredQuestions).toEqual(['t']);
    expect(d.statusOf('t')).toBe('needs_input'); // not turned into an error by the dead process
    expect(d.svc.getPendingPermission('t')).toEqual(QUESTION);
  });

  it('without a saved question the thread with a dead process is marked failed, as before', () => {
    const first = boot();
    first.manager.live.add('t');
    first.manager.emit('busy', 't');
    first.manager.ask('t', { requestId: 'tool-1', toolName: 'Bash', input: { command: 'rm -rf x' } }); // a gated tool: no question to show again
    expect(pendingQuestionsDb.get(first.db, 't')).toBeUndefined();
    const d = boot();
    expect(d.recover().restoredQuestions).toEqual([]);
    expect(d.statusOf('t')).toBe('error');
    expect(d.svc.getPendingPermission('t')).toBeNull();
  });

  it('the row is removed when the question is resolved', () => {
    const d = boot();
    ask(d);
    expect(d.svc.answerPermission('t', 'req-1', { decision: 'allow', answers: { 'Which branch do I use?': 'main' } })).toBe(true);
    expect(pendingQuestionsDb.get(d.db, 't')).toBeUndefined();
    const next = boot();
    expect(next.recover().restoredQuestions).toEqual([]);
    expect(next.svc.getPendingPermission('t')).toBeNull();
  });

  it('a live question always wins over a saved one', () => {
    const first = boot();
    ask(first);
    const d = boot();
    d.recover();
    const newer = { ...QUESTION, requestId: 'req-2' };
    ask(d, 't', newer);
    expect(d.svc.getPendingPermission('t')).toEqual(newer);
    expect(pendingQuestionsDb.get(d.db, 't')).toMatchObject({ request_id: 'req-2' });
  });

  it('an answer to a restored question revives the thread and sends one message', () => {
    ask(boot());
    const d = boot();
    d.recover();
    const cleared: string[] = [];
    d.manager.on('permission-cleared', (id: string) => cleared.push(id));
    expect(d.manager.isAlive('t')).toBe(false);

    expect(d.svc.answerPermission('t', 'req-1', { decision: 'allow', answers: { 'Which branch do I use?': 'release' } })).toBe(true);

    expect(d.manager.spawns).toEqual(['t']); // revived
    expect(d.manager.sent).toHaveLength(1);
    const text = String(d.manager.sent[0].content);
    expect(d.manager.sent[0]).toMatchObject({ id: 't', source: 'user' });
    expect(text).toContain('Which branch do I use?'); // it quotes the question
    expect(text).toContain('release');
    expect(text).toContain('Dispatch restarted');
    expect(pendingQuestionsDb.get(d.db, 't')).toBeUndefined();
    expect(d.svc.getPendingPermission('t')).toBeNull();
    expect(cleared).toEqual(['t']); // every viewer drops the card
    expect(d.statusOf('t')).toBe('working');
    // A second answer finds nothing.
    expect(d.svc.answerPermission('t', 'req-1', { decision: 'allow', answers: { 'Which branch do I use?': 'main' } })).toBe(false);
    expect(d.manager.sent).toHaveLength(1);
  });

  it('an answer with another requestId is refused and nothing is sent', () => {
    ask(boot());
    const d = boot();
    d.recover();
    expect(d.svc.answerPermission('t', 'req-other', { decision: 'allow', answers: {} })).toBe(false);
    expect(d.manager.sent).toHaveLength(0);
    expect(d.svc.getPendingPermission('t')).toEqual(QUESTION);
  });

  it('a typed reply, a Discuss and a Dismiss to a restored question each send one message that quotes it', () => {
    for (const run of [
      (svc: SessionService) => svc.answerQuestionInChat('t', 'req-1', 'use the hotfix branch') === 'delivered',
      (svc: SessionService) => svc.answerPermission('t', 'req-1', { decision: 'deny', canned: 'discuss' }),
      (svc: SessionService) => svc.answerPermission('t', 'req-1', { decision: 'deny', canned: 'dismiss' }),
      (svc: SessionService) => svc.answerPermission('t', 'req-1', { decision: 'deny', message: 'not now' }),
    ]) {
      fs.rmSync(dbPath, { force: true }); fs.rmSync(`${dbPath}-wal`, { force: true }); fs.rmSync(`${dbPath}-shm`, { force: true });
      const seed = new Database(dbPath); initSchema(seed);
      sessionsDb.create(seed, { id: 's1', provider: 'claude-code', name: 'p', workingDir: dir });
      terminalsDb.create(seed, { id: 't', sessionId: 's1', type: 'claude-code', label: 'Poller', config: { transport: 'structured' } });
      seed.close();
      ask(boot());
      const d = boot();
      d.recover();
      expect(run(d.svc)).toBe(true);
      expect(d.manager.sent).toHaveLength(1);
      expect(String(d.manager.sent[0].content)).toContain('Which branch do I use?');
      expect(pendingQuestionsDb.get(d.db, 't')).toBeUndefined();
    }
  });

  it('a new message to the thread makes the saved question stale', () => {
    ask(boot());
    const d = boot();
    d.recover();
    d.svc.sendStructuredMessage('t', 'forget it, do something else', 'user');
    expect(pendingQuestionsDb.get(d.db, 't')).toBeUndefined();
    expect(d.svc.getPendingPermission('t')).toBeNull();
  });

  it('a status reset hides the saved question', () => {
    ask(boot());
    const d = boot();
    d.recover();
    d.status.resetStatus('t');
    expect(d.svc.getPendingPermission('t')).toBeNull();
  });

  it('a saved question of an archived thread is not restored, and of a deleted thread is removed', () => {
    const first = boot();
    ask(first);
    ask(first, 'lead', { ...QUESTION, requestId: 'req-9' });
    terminalsDb.archive(first.db, 't');
    first.db.prepare("DELETE FROM terminals WHERE id = 'lead'").run();
    const d = boot();
    expect(d.recover().restoredQuestions).toEqual([]);
    expect(pendingQuestionsDb.get(d.db, 'lead')).toBeUndefined();
  });

  // v4.5.0 review (minor): the archive deleted the saved question, so a restored thread said "needs input" with no card.
  it('an archive keeps the saved question and a restore shows its card again; a delete of the project removes it', () => {
    ask(boot());
    const d = boot(); // the restart: the question lives in the database only
    expect(d.recover().restoredQuestions).toEqual(['t']);
    d.svc.removeTerminal('t'); // archive
    expect(terminalsDb.getById(d.db, 't')!.archived_at).toBeTruthy();
    expect(pendingQuestionsDb.get(d.db, 't')).toBeDefined();
    expect(d.svc.getPendingPermission('t')).toBeNull(); // an archived thread shows no card
    d.svc.restoreTerminal('t');
    expect(d.statusOf('t')).toBe('needs_input');
    expect(d.svc.getPendingPermission('t')).toMatchObject({ requestId: 'req-1', questions: QUESTION.questions });
    d.svc.removeTerminal('t');
    d.svc.archive('s1'); // the project is deleted: its threads are gone for good
    expect(pendingQuestionsDb.get(d.db, 't')).toBeUndefined();
  });

  it('a question whose process is still alive is not listed as restored', () => {
    const d = boot();
    ask(d);
    expect(d.recover().restoredQuestions).toEqual([]);
    expect(d.statusOf('t')).toBe('needs_input');
  });
});
