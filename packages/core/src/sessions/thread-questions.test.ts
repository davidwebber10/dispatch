// ThreadQuestions alone: built from its typed inputs, with no SessionService.
import { describe, it, expect, beforeEach } from 'vitest';
import { ThreadQuestions } from './thread-questions.js';
import { questionReplyMessage, QUESTION_DISCUSS_MESSAGE } from './question-reply.js';

class FakeManager {
  repliesToQuestions = true;
  pending: any = null;
  answered: [string, string, any][] = [];
  getPending() { return this.pending; }
  answerPermission(id: string, requestId: string, decision: any) {
    if (!this.pending) return false;
    this.pending = null;
    this.answered.push([id, requestId, decision]);
    return true;
  }
}

const QUESTIONS = [{ question: 'Which database?', header: 'DB' }, { question: 'Ship today?', header: 'Ship' }];
let mgr: FakeManager;
let logs: [string, string, string][];
let notes: unknown[][];
let restored: any;
let q: ThreadQuestions;

beforeEach(() => {
  mgr = new FakeManager();
  logs = [];
  notes = [];
  restored = undefined;
  q = new ThreadQuestions({
    threads: {
      structuredManagerForTerminal: (id) => (id === 't' ? (mgr as any) : undefined),
      restoredQuestions: () => restored,
      logCoordinatorMessage: (id, content, source) => { logs.push([id, content, source]); },
      noteQuestionAnsweredInChat: (...a) => { notes.push(a); },
    },
  });
});

describe('ThreadQuestions', () => {
  it('an allowed question card: answers on question-text keys, one log row per answered question', () => {
    mgr.pending = { requestId: 'r1', toolName: 'AskUserQuestion', input: {}, questions: QUESTIONS };
    expect(q.answerPermission('t', 'r1', { decision: 'allow', answers: { DB: 'pg', 'Ship today?': 'no' } })).toBe(true);
    expect(mgr.answered[0][2].updatedInput.answers).toEqual({ 'Which database?': 'pg', 'Ship today?': 'no' });
    expect(logs).toEqual([['t', 'pg', 'user'], ['t', 'no', 'user']]);
  });

  it('a canned Discuss: the fixed text, logged as canned, and the coordinator is told', () => {
    mgr.pending = { requestId: 'r1', toolName: 'AskUserQuestion', questions: QUESTIONS };
    expect(q.answerPermission('t', 'r1', { decision: 'deny', canned: 'discuss' })).toBe(true);
    expect(mgr.answered[0][2]).toEqual({ behavior: 'deny', message: QUESTION_DISCUSS_MESSAGE });
    expect(logs).toEqual([['t', QUESTION_DISCUSS_MESSAGE, 'canned']]);
    expect(notes).toEqual([['t', '', 0, 'discuss']]);
  });

  it('a chat reply from the user: delivered, logged as user, the coordinator told; from Chat: logged as coordinator, nobody told', () => {
    mgr.pending = { requestId: 'r1', toolName: 'AskUserQuestion', questions: QUESTIONS };
    expect(q.answerQuestionInChat('t', 'r1', 'pg', 2)).toBe('delivered');
    expect(mgr.answered[0][2]).toEqual({ behavior: 'deny', message: questionReplyMessage('pg', 2, 'user') });
    mgr.pending = { requestId: 'r2', toolName: 'AskUserQuestion', questions: QUESTIONS };
    expect(q.answerQuestionInChat('t', 'r2', 'sqlite', 0, 'chat')).toBe('delivered');
    expect(logs).toEqual([['t', 'pg', 'user'], ['t', 'sqlite', 'coordinator']]);
    expect(notes).toEqual([['t', 'pg', 2, undefined]]);
  });

  it('the saved questions are read at each answer, so a late wire is seen', () => {
    expect(q.answerPermission('t', 'r1', { decision: 'allow' })).toBe(false);
    restored = { answer: () => true };
    expect(q.answerPermission('t', 'r1', { decision: 'allow' })).toBe(true);
    expect(q.answerPermission('other', 'r1', { decision: 'allow' })).toBe(false); // no manager for that thread
  });
});
