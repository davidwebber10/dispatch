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
import { QUESTION_DISMISS_MESSAGE, QUESTION_DISCUSS_MESSAGE, questionReplyMessage } from '../../src/sessions/question-reply.js';

class FakePty extends EventEmitter {
  isAlive() { return false; }
  write() {}
  kill() {}
  spawn() { return 1; }
  setDefaultEnv() {}
}

class FakeStructured extends EventEmitter implements IStructuredManager {
  repliesToQuestions = true;
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

describe('a chat reply to a pending question', () => {
  const QUESTIONS = [{ header: 'Store', question: 'Which store goes first?', options: [{ label: 'A' }, { label: 'B' }] }];
  const ask = (id: string, requestId = 'r1') => {
    structured.pendings.set(id, { requestId, toolName: 'AskUserQuestion', input: { questions: QUESTIONS }, questions: QUESTIONS });
  };

  it('denies with the N4 message, logs the raw reply as one user row, and sends no user turn', () => {
    const ledger = new LedgerService(db, { clock: () => Date.parse('2026-10-05T16:00:00.000Z') });
    ledger.add('s1', 'coord', { kind: 'decide', text: 'Which store goes first?', ...DECIDE_CARD });
    ask('coord');
    expect(svc.answerQuestionInChat('coord', 'r1', 'Neither. Start with the outlet store.')).toBe('delivered');
    expect(structured.answered).toEqual([{ id: 'coord', decision: { behavior: 'deny', message: questionReplyMessage('Neither. Start with the outlet store.') } }]);
    expect(structured.sent).toEqual([]);
    expect(log()).toEqual([{ source: 'user', text: 'Neither. Start with the outlet store.' }]);
    expect(ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'Start with the outlet store.' }).status).toBe('answered');
  });

  it('a reply from Chat is worded as Chat\'s, logs no user row, and tells no coordinator that the user answered', () => {
    ask('agent');
    expect(svc.answerQuestionInChat('agent', 'r1', 'Yes, deploy.', 0, 'chat')).toBe('delivered');
    expect(structured.answered).toEqual([{ id: 'agent', decision: { behavior: 'deny', message: questionReplyMessage('Yes, deploy.', 0, 'chat') } }]);
    const message = (structured.answered[0].decision as any).message as string;
    expect(message).toContain('Chat, the assistant that works for the user, replied: Yes, deploy.');
    expect(message).not.toContain('They replied');
    expect(structured.sent.filter((m) => m.id === 'coord')).toEqual([]); // the coordinator is not told "the user answered"
    ask('coord');
    expect(svc.answerQuestionInChat('coord', 'r1', 'Yes, deploy.', 0, 'chat')).toBe('delivered');
    expect(log()).toEqual([{ source: 'coordinator', text: 'Yes, deploy.' }]); // never a user row: a ledger quote cannot be Chat's words
  });

  it('requires the pending requestId: a missing or stale id is not-found and logs nothing', () => {
    ask('coord', 'r2');
    expect(svc.answerQuestionInChat('coord', '', 'hi')).toBe('not-found');
    expect(svc.answerQuestionInChat('coord', 'r1', 'hi')).toBe('not-found');
    expect(structured.answered).toEqual([]);
    expect(log()).toEqual([]);
  });

  it('is not-found for a plain gated tool, which is not a question', () => {
    structured.pendings.set('coord', { requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } });
    expect(svc.answerQuestionInChat('coord', 'r1', 'hi')).toBe('not-found');
  });

  it('is unsupported, and writes nothing, on a harness that drops a deny message', () => {
    structured.repliesToQuestions = false;
    ask('coord');
    expect(svc.answerQuestionInChat('coord', 'r1', 'hi')).toBe('unsupported');
    expect(structured.answered).toEqual([]);
    expect(structured.pendings.has('coord')).toBe(true);
    expect(log()).toEqual([]);
  });

  it('an image-only reply logs no user row, and the message says images follow', () => {
    ask('coord');
    expect(svc.answerQuestionInChat('coord', 'r1', '', 2)).toBe('delivered');
    expect((structured.answered[0].decision as any).message).toContain('They replied with an image only. (2 images. They follow in the next message.)');
    expect(log()).toEqual([]);
  });

  it('Dismiss and an empty Discuss deny with their fixed text and log it as canned', () => {
    ask('coord');
    expect(svc.answerPermission('coord', 'r1', { decision: 'deny', canned: 'dismiss' })).toBe(true);
    ask('coord');
    expect(svc.answerPermission('coord', 'r1', { decision: 'deny', canned: 'discuss' })).toBe(true);
    expect(structured.answered.map((a) => (a.decision as any).message)).toEqual([QUESTION_DISMISS_MESSAGE, QUESTION_DISCUSS_MESSAGE]);
    expect(log()).toEqual([{ source: 'canned', text: QUESTION_DISMISS_MESSAGE }, { source: 'canned', text: QUESTION_DISCUSS_MESSAGE }]);
  });

  it('Dismiss and an empty Discuss on a harness that drops a deny message send a plain deny, log nothing canned, and discuss tells nobody', () => {
    structured.repliesToQuestions = false;
    ask('agent');
    expect(svc.answerPermission('agent', 'r1', { decision: 'deny', canned: 'dismiss' })).toBe(true);
    ask('agent');
    expect(svc.answerPermission('agent', 'r1', { decision: 'deny', canned: 'discuss' })).toBe(true);
    expect(structured.answered.map((a) => (a.decision as any).message)).toEqual(['Denied', 'Denied']);
    expect(log().filter((r: any) => r.source === 'canned')).toEqual([]);
    const notices = structured.sent.filter((m) => m.id === 'coord').map((m) => m.content);
    expect(notices).toHaveLength(1); // the dismiss closes the question; the discuss text never reached the agent
    expect(notices[0]).toEqual(expect.stringContaining('dismissed it without answering'));
  });

  it('the coordinator notice for Dismiss and Discuss does not claim the user answered in the agent chat', () => {
    ask('agent');
    svc.answerPermission('agent', 'r1', { decision: 'deny', canned: 'dismiss' });
    ask('agent');
    svc.answerPermission('agent', 'r1', { decision: 'deny', canned: 'discuss' });
    for (const n of structured.sent.filter((m) => m.id === 'coord').map((m) => String(m.content))) {
      expect(n).not.toContain("directly in the agent's chat");
      expect(n).toContain('Do not call answer_agent for that question.');
    }
  });

  it("Dismiss and an empty Discuss in a worker's chat tell the coordinator the question is closed", () => {
    ask('agent');
    expect(svc.answerPermission('agent', 'r1', { decision: 'deny', canned: 'dismiss' })).toBe(true);
    ask('agent');
    expect(svc.answerPermission('agent', 'r1', { decision: 'deny', canned: 'discuss' })).toBe(true);
    const notices = structured.sent.filter((m) => m.id === 'coord').map((m) => m.content);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toEqual(expect.stringContaining('dismissed it without answering'));
    expect(notices[1]).toEqual(expect.stringContaining('asked it to explain the options first'));
    for (const n of notices) expect(n).toEqual(expect.stringContaining('Do not call answer_agent for that question.'));
  });

  it("a reply in a worker's chat tells the coordinator the question is answered, not that the user messaged it", () => {
    ask('agent');
    expect(svc.answerQuestionInChat('agent', 'r1', 'Go with B.')).toBe('delivered');
    const notice = structured.sent.find((m) => m.id === 'coord');
    expect(notice?.content).toEqual(expect.stringContaining('The user answered the question your agent "worker"'));
    expect(notice?.content).toEqual(expect.stringContaining('"Go with B."'));
    expect(notice?.content).toEqual(expect.stringContaining('Do not call answer_agent for that question.'));
    expect(notice?.content).not.toEqual(expect.stringContaining('a message directly'));
    expect(structured.sent.filter((m) => m.id === 'agent')).toEqual([]);
  });

  it("the coordinator's question notice names the requestId for answer_agent", () => {
    ask('agent', 'req-77');
    expect(svc.routeAgentQuestionToCoordinator('agent', { toolName: 'AskUserQuestion', questions: QUESTIONS })).toBe(true);
    const notice = structured.sent.find((m) => m.id === 'coord');
    expect(notice?.content).toEqual(expect.stringContaining('answer_agent({ agentId: "agent", requestId: "req-77", answers: { "<header>": "<chosen option>" } })'));
  });
});

describe('the reply wording', () => {
  it('is the fixed prefix, the reply, a blank line, then the guidance line', () => {
    expect(questionReplyMessage('Neither.')).toBe(
      'The user did not pick an option. They replied: Neither.\n\n' +
      'Treat this as their answer. If it settles the question, continue. If it pushes back on the options or asks for ' +
      'more context, answer them in plain text and then ask again with revised options. Do not proceed on a guess.',
    );
  });

  it('says how many images follow', () => {
    expect(questionReplyMessage('See this', 1)).toContain('They replied: See this\n\n(They also attached 1 image. It follows in the next message.)');
  });
});
