// W3-B characterization: how SessionService answers the question or gated tool of a structured
// thread, recorded through the facade before the code moved to ThreadQuestions. The facade must do
// the same after the move. (tests/sessions/coordinator-message-log.test.ts covers the log rows.)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { SessionService } from '../../src/sessions/service.js';
import { questionReplyMessage, QUESTION_DISMISS_MESSAGE } from '../../src/sessions/question-reply.js';

class FakeStructured extends EventEmitter {
  repliesToQuestions = true;
  pendings = new Map<string, any>();
  answered: [string, string, any][] = [];
  isAlive() { return true; }
  getPending(id: string) { return this.pendings.get(id) ?? null; }
  answerPermission(id: string, requestId: string, decision: any) {
    if (!this.pendings.has(id)) return false;
    this.pendings.delete(id);
    this.answered.push([id, requestId, decision]);
    return true;
  }
}

let db: Database.Database;
let mgr: FakeStructured;
let svc: SessionService;
const QUESTIONS = [
  { question: 'Which database?', header: 'DB', options: [{ label: 'sqlite' }, { label: 'pg' }] },
  { question: 'Ship today?', header: 'Ship', options: [{ label: 'yes' }, { label: 'no' }] },
];

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/nowhere' });
  terminalsDb.create(db, { id: 't', sessionId: 's1', type: 'claude-code', label: 't', config: { transport: 'structured' } });
  terminalsDb.create(db, { id: 'cli', sessionId: 's1', type: 'codex', label: 'cli' });
  mgr = new FakeStructured();
  svc = new SessionService(db, new EventEmitter() as any, '/nowhere/mcp.json');
  svc.registerStructuredManager('claude-code', mgr as any);
});
afterEach(() => { db.close(); });

describe('SessionService answerPermission (characterization)', () => {
  it('allow: answers keyed by header or by question text land on question-text keys, folded into the original input', () => {
    mgr.pendings.set('t', { requestId: 'r1', toolName: 'AskUserQuestion', input: { a: 1 }, questions: QUESTIONS });
    expect(svc.answerPermission('t', '', { decision: 'allow', answers: { DB: 'pg', 'Ship today?': 'yes', Other: 'x' } })).toBe(true);
    expect(mgr.answered).toEqual([['t', 'r1', {
      behavior: 'allow',
      updatedInput: { a: 1, questions: QUESTIONS, answers: { 'Which database?': 'pg', 'Ship today?': 'yes' } },
    }]]);
  });

  it('allow with no answers: the original input only; a plain gated tool has no questions key', () => {
    mgr.pendings.set('t', { requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } });
    expect(svc.answerPermission('t', 'r1', { decision: 'allow' })).toBe(true);
    expect(mgr.answered[0][2]).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
  });

  it('deny: the given message, or "Denied"; a canned Dismiss sends its fixed text', () => {
    mgr.pendings.set('t', { requestId: 'r1', toolName: 'Bash' });
    svc.answerPermission('t', 'r1', { decision: 'deny', message: 'not now' });
    mgr.pendings.set('t', { requestId: 'r2', toolName: 'Bash' });
    svc.answerPermission('t', 'r2', { decision: 'deny' });
    mgr.pendings.set('t', { requestId: 'r3', toolName: 'AskUserQuestion', questions: QUESTIONS });
    svc.answerPermission('t', 'r3', { decision: 'deny', canned: 'dismiss' });
    expect(mgr.answered.map((a) => a[2])).toEqual([
      { behavior: 'deny', message: 'not now' },
      { behavior: 'deny', message: 'Denied' },
      { behavior: 'deny', message: QUESTION_DISMISS_MESSAGE },
    ]);
  });

  it('a canned answer on a harness that drops a deny message: a plain "Denied"', () => {
    mgr.repliesToQuestions = false;
    mgr.pendings.set('t', { requestId: 'r1', toolName: 'AskUserQuestion', questions: QUESTIONS });
    expect(svc.answerPermission('t', 'r1', { decision: 'deny', canned: 'discuss' })).toBe(true);
    expect(mgr.answered[0][2]).toEqual({ behavior: 'deny', message: 'Denied' });
  });

  it('no manager for the thread: false; nothing pending and no saved question: false', () => {
    expect(svc.answerPermission('cli', 'r1', { decision: 'allow' })).toBe(false);
    expect(svc.answerPermission('t', 'r1', { decision: 'allow' })).toBe(false);
  });

  it('nothing pending, but a question saved before a restart: the saved question takes the answer', () => {
    const calls: unknown[][] = [];
    svc.setRestoredQuestions({ get: () => null, answer: (...a: unknown[]) => { calls.push(a); return true; } } as any);
    expect(svc.answerPermission('t', 'r9', { decision: 'allow', answers: { DB: 'pg' } })).toBe(true);
    expect(calls).toEqual([['t', 'r9', { decision: 'allow', answers: { DB: 'pg' } }]]);
  });
});

describe('SessionService answerQuestionInChat (characterization)', () => {
  it('delivered: the reply rides a deny with the fixed wording', () => {
    mgr.pendings.set('t', { requestId: 'r1', toolName: 'AskUserQuestion', questions: QUESTIONS });
    expect(svc.answerQuestionInChat('t', 'r1', 'use pg', 1)).toBe('delivered');
    expect(mgr.answered).toEqual([['t', 'r1', { behavior: 'deny', message: questionReplyMessage('use pg', 1, 'user') }]]);
  });

  it('not-found: a stale or missing requestId, a gated tool that is not a question, or no manager', () => {
    mgr.pendings.set('t', { requestId: 'r1', toolName: 'AskUserQuestion', questions: QUESTIONS });
    expect(svc.answerQuestionInChat('t', 'r0', 'x')).toBe('not-found');
    expect(svc.answerQuestionInChat('t', '', 'x')).toBe('not-found');
    mgr.pendings.set('t', { requestId: 'r1', toolName: 'Bash' });
    expect(svc.answerQuestionInChat('t', 'r1', 'x')).toBe('not-found');
    expect(svc.answerQuestionInChat('cli', 'r1', 'x')).toBe('not-found');
    expect(mgr.answered).toEqual([]);
  });

  it('unsupported: a harness that drops a deny message', () => {
    mgr.repliesToQuestions = false;
    mgr.pendings.set('t', { requestId: 'r1', toolName: 'AskUserQuestion', questions: QUESTIONS });
    expect(svc.answerQuestionInChat('t', 'r1', 'x')).toBe('unsupported');
  });

  it('a question saved before a restart takes a chat reply', () => {
    const calls: unknown[][] = [];
    svc.setRestoredQuestions({ get: () => null, answer: (...a: unknown[]) => { calls.push(a); return true; } } as any);
    expect(svc.answerQuestionInChat('t', 'r9', 'pg please', 0, 'chat')).toBe('delivered');
    expect(calls).toEqual([['t', 'r9', { reply: 'pg please', imageCount: 0, from: 'chat' }]]);
  });
});
