// The overseer message log (structured-recap spec, Unit 1): every message that reaches a
// coordinator is logged with its sender, at the one write point all structured sends share.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../../src/db/connection.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as messagesDb from '../../src/db/coordinator-messages.js';
import { SessionService } from '../../src/sessions/service.js';
import type { IStructuredManager, PendingPermission } from '../../src/structured/manager.js';
import { LedgerService } from '../../src/overseer/ledger-service.js';
import { DECIDE_CARD, GO_CARD } from '../overseer/card-fixtures.js';

class FakePty extends EventEmitter {
  isAlive() { return false; }
  write() {}
  kill() {}
  spawn() { return 1; }
  setDefaultEnv() {}
}

class FakeStructured extends EventEmitter implements IStructuredManager {
  live = new Set<string>();
  sent: { id: string; content: unknown; source?: string }[] = [];
  pendings = new Map<string, PendingPermission>();
  answered: { id: string; decision: unknown }[] = [];
  /** False: the answer is not delivered (no matching pending in the real manager). */
  deliver = true;
  setDefaultEnv() {}
  spawn(id: string) { this.live.add(id); return 1; }
  sendMessage(id: string, content: unknown, source?: any) { this.sent.push({ id, content, source }); }
  answerPermission(id: string, _requestId: string, decision: unknown) {
    if (!this.deliver || !this.pendings.has(id)) return false;
    this.pendings.delete(id);
    this.answered.push({ id, decision });
    return true;
  }
  setEscalate() { return false; }
  interrupt() { return true; }
  compact() {}
  noteDeclaredStatus() {}
  getPending(id: string) { return this.pendings.get(id) ?? null; }
  getSessionId() { return undefined; }
  getEvents() { return []; }
  getEventsTail() { return []; }
  getTurnTexts(): string[] | null { return null; }
  isAlive(id: string) { return this.live.has(id); }
  kill(id: string) { this.live.delete(id); }
  killAll() { this.live.clear(); }
}

let dir: string;
let db: Database.Database;
let svc: SessionService;
let structured: FakeStructured;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-msglog-'));
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: dir });
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { transport: 'structured', role: 'coordinator' } });
  terminalsDb.create(db, { id: 'agent', sessionId: 's1', type: 'claude-code', label: 'worker', config: { transport: 'structured', role: 'agent', agentType: 'implementer' } });
  structured = new FakeStructured();
  structured.live.add('coord');
  structured.live.add('agent');
  svc = new SessionService(db, new FakePty() as any, path.join(dir, 'mcp.json'));
  svc.setStructuredManager(structured);
  svc.clock = () => Date.parse('2026-10-05T17:00:00.000Z');
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const log = () => messagesDb.listForTerminal(db, 'coord').map((m) => ({ source: m.source, text: m.text }));

describe('overseer message log', () => {
  it('logs a human send as user, a peer send as coordinator, and an untagged send as daemon', () => {
    svc.sendStructuredMessage('coord', 'hello', 'user');
    svc.sendStructuredMessage('coord', 'from a peer', 'coordinator');
    svc.sendStructuredMessage('coord', '✅ Your agent "worker" just finished a turn.');
    expect(log()).toEqual([
      { source: 'user', text: 'hello' },
      { source: 'coordinator', text: 'from a peer' },
      { source: 'daemon', text: '✅ Your agent "worker" just finished a turn.' },
    ]);
    expect(messagesDb.listForTerminal(db, 'coord')[0].sentAt).toBe('2026-10-05T17:00:00.000Z');
  });

  it('logs a canned card click as canned even though its source is user', () => {
    svc.sendThreadMessage('coord', '“Deploy” — got it.', 'user', 'canned');
    expect(log()).toEqual([{ source: 'canned', text: '“Deploy” — got it.' }]);
    expect(structured.sent[0].source).toBe('user'); // the badge tag is unchanged
  });

  it('joins text blocks and writes an image as [image]', () => {
    svc.sendStructuredMessage('coord', [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
      { type: 'text', text: 'look at this' },
    ], 'user');
    expect(log()).toEqual([{ source: 'user', text: '[image]\nlook at this' }]);
  });

  it('never logs a message to a thread that is not a coordinator', () => {
    svc.sendStructuredMessage('agent', 'do the task', 'coordinator');
    expect(messagesDb.listForTerminal(db, 'agent')).toEqual([]);
  });

  it('mid-turn: a user send and then a daemon notice are both logged, each with its own source', () => {
    svc.sendThreadMessage('coord', 'check the staging bucket', 'user');
    svc.noteAgentCompletion('agent'); // a notice arrives while the overseer's turn still runs
    expect(log().map((m) => m.source)).toEqual(['user', 'daemon']);
    expect(log()[0].text).toBe('check the staging bucket');
    expect(log()[1].text.startsWith('✅ Your agent "worker" [agentId agent] just finished a turn.')).toBe(true);
  });

  it('a failed log write is reported and does not block the send', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.exec('DROP TABLE coordinator_messages');
    expect(() => svc.sendStructuredMessage('coord', 'still delivered', 'user')).not.toThrow();
    expect(structured.sent.map((s) => s.content)).toEqual(['still delivered']);
    expect(err).toHaveBeenCalled();
  });
});

describe('the user\'s answer to the overseer\'s own question card', () => {
  const QUESTIONS = [
    { header: 'Store', question: 'Which store goes first?', options: [{ label: 'A' }, { label: 'B' }] },
    { header: 'Checks', question: 'Which checks run?', multiSelect: true, options: [{ label: 'Lint' }, { label: 'Tests' }] },
  ];
  const ask = (id: string) => {
    structured.pendings.set(id, { requestId: 'r1', toolName: 'AskUserQuestion', input: { questions: QUESTIONS }, questions: QUESTIONS });
  };

  it('is logged as user, one row per question with the answer only, and a quote from it resolves an item', () => {
    const ledger = new LedgerService(db, { clock: () => Date.parse('2026-10-05T16:00:00.000Z') });
    ledger.add('s1', 'coord', { kind: 'decide', text: 'Which store goes first?', ...DECIDE_CARD });
    ask('coord');
    expect(svc.answerPermission('coord', 'r1', {
      decision: 'allow',
      // The web keys answers by question text: a free-text "Other" answer, and a multi-select joined with ", ".
      answers: { 'Which store goes first?': 'A, but only the first store', 'Which checks run?': 'Lint, Tests' },
    })).toBe(true);
    expect(log()).toEqual([
      { source: 'user', text: 'A, but only the first store' },
      { source: 'user', text: 'Lint, Tests' },
    ]);
    expect(ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'A, but only the first store' }).status).toBe('answered');
  });

  it('accepts answers keyed by header, and logs only the questions that have an answer', () => {
    ask('coord');
    svc.answerPermission('coord', '', { decision: 'allow', answers: { Store: 'B' } });
    expect(log()).toEqual([{ source: 'user', text: 'B' }]);
  });

  // The overseer writes the header and the question; only the answer is the user's. A header must
  // never become quotable evidence, and an "ok" answer is a leading ok of its own message.
  it('never logs the overseer-written header, so a header word cannot approve anything', () => {
    const ledger = new LedgerService(db, { clock: () => Date.parse('2026-10-05T16:00:00.000Z') });
    ledger.add('s1', 'coord', { kind: 'go', text: 'Merge PR 7 into main?', ...GO_CARD });
    ledger.add('s1', 'coord', { kind: 'decide', text: 'Which store goes first?', ...DECIDE_CARD });
    const qs = [
      { header: 'Merge', question: 'Merge PR 7 now?', options: [{ label: 'yes' }, { label: 'no' }] },
      { header: 'Store', question: 'Which store goes first?', options: [{ label: 'ok' }, { label: 'B' }] },
    ];
    structured.pendings.set('coord', { requestId: 'r1', toolName: 'AskUserQuestion', input: { questions: qs }, questions: qs });
    svc.answerPermission('coord', 'r1', { decision: 'allow', answers: { 'Merge PR 7 now?': 'no', 'Which store goes first?': 'ok' } });
    expect(log()).toEqual([{ source: 'user', text: 'no' }, { source: 'user', text: 'ok' }]);
    expect(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'Merge' })).toThrow(/Quote not found/);
    expect(() => ledger.resolve('s1', 'coord', { id: 'N2', status: 'answered', quote: 'ok' })).toThrow(/An 'ok' at the start/);
  });

  it('is not logged for an ordinary tool permission, a deny, or a delivery that failed', () => {
    structured.pendings.set('coord', { requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } });
    svc.answerPermission('coord', 'r1', { decision: 'allow' });
    ask('coord');
    svc.answerPermission('coord', 'r1', { decision: 'deny', message: 'no' });
    ask('coord');
    structured.deliver = false;
    expect(svc.answerPermission('coord', 'r1', { decision: 'allow', answers: { Store: 'A' } })).toBe(false);
    expect(log()).toEqual([]);
  });

  it('is not logged for a thread that is not a coordinator', () => {
    ask('agent');
    svc.answerPermission('agent', 'r1', { decision: 'allow', answers: { Store: 'A' } });
    expect(messagesDb.listForTerminal(db, 'agent')).toEqual([]);
  });

  it('a failed log write is reported and never blocks the answer', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.exec('DROP TABLE coordinator_messages');
    ask('coord');
    expect(svc.answerPermission('coord', 'r1', { decision: 'allow', answers: { Store: 'A' } })).toBe(true);
    expect(structured.answered).toHaveLength(1);
    expect(err).toHaveBeenCalled();
  });
});
