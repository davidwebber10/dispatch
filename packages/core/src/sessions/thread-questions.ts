import type * as coordinatorMessagesDb from '../db/coordinator-messages.js';
import { QUESTION_CANNED_MESSAGES, questionReplyMessage, type QuestionCannedAction } from './question-reply.js';
import type { RestoredQuestions } from './boot-reconcile.js';

type IStructuredManager = import('../structured/manager.js').IStructuredManager;

/** What ThreadQuestions needs. Every field is required. */
export interface ThreadQuestionsDeps {
  /** The thread operations that an answer uses. SessionService gives its own methods. */
  threads: {
    structuredManagerForTerminal(terminalId: string): IStructuredManager | undefined;
    /** The questions that only the database still holds after a restart (W2-C); undefined until wired. */
    restoredQuestions(): RestoredQuestions | undefined;
    /** The overseer message log (SessionService.logCoordinatorMessage). */
    logCoordinatorMessage(terminalId: string, content: string, source: coordinatorMessagesDb.CoordinatorMessageSource): void;
    /** Tells a worker's coordinator that the question was answered or closed in the worker's chat. */
    noteQuestionAnsweredInChat(agentTerminalId: string, reply: string, imageCount: number, canned?: QuestionCannedAction): void;
  };
}

/**
 * The answers to the question or gated tool of a structured thread (W3-B: moved out of
 * SessionService): an allow with the answers of a question card, a deny, a canned Dismiss or
 * Discuss, and a chat reply to a question.
 */
export class ThreadQuestions {
  constructor(private readonly deps: ThreadQuestionsDeps) {}

  // The inputs under the names the moved code uses.
  private structuredManagerForTerminal(terminalId: string): IStructuredManager | undefined { return this.deps.threads.structuredManagerForTerminal(terminalId); }
  private get restoredQuestions(): RestoredQuestions | undefined { return this.deps.threads.restoredQuestions(); }
  private logCoordinatorMessage(terminalId: string, content: string, source: coordinatorMessagesDb.CoordinatorMessageSource): void { this.deps.threads.logCoordinatorMessage(terminalId, content, source); }
  private noteQuestionAnsweredInChat(agentTerminalId: string, reply: string, imageCount: number, canned?: QuestionCannedAction): void { this.deps.threads.noteQuestionAnsweredInChat(agentTerminalId, reply, imageCount, canned); }

  /**
   * The real `claude` CLI's AskUserQuestion tool result mapper looks up each answer by
   * the question's `question` TEXT (`answers[q.question]`), never its `header` — but
   * formatAgentQuestion / answer_agent's coordinator-facing contract documents answering
   * by header (for readability in the notice), and agency-mcp.ts's bare-`answer` shortcut
   * builds a header-keyed map too. Remap here, once, so every caller — however it keyed
   * its answers — lands on the question-text keys the CLI actually reads. Accepts either
   * key per question so the already-correct web path (AskQuestionCard.tsx / store.ts,
   * which already key by `q.question`) passes through unchanged.
   */
  private remapAnswersToQuestionText(questions: any[] | undefined, answers: Record<string, string>): Record<string, string> {
    const qs = Array.isArray(questions) ? questions : [];
    const remapped: Record<string, string> = {};
    for (const q of qs) {
      const key = q?.question;
      if (typeof key !== 'string' || !key) continue;
      const value = answers[key] ?? (typeof q?.header === 'string' ? answers[q.header] : undefined);
      if (value !== undefined) remapped[key] = value;
    }
    return remapped;
  }

  /**
   * Resolve a structured thread's pending gated tool. `allow` echoes the original
   * input back to the tool, folding in the original `questions` and any AskUserQuestion
   * `answers` map (remapped onto question-text keys — see remapAnswersToQuestionText);
   * `deny` sends a message. Returns false when nothing is pending.
   */
  answerPermission(
    terminalId: string,
    requestId: string,
    opts: { decision: 'allow' | 'deny'; answers?: Record<string, string>; message?: string; canned?: QuestionCannedAction; logAs?: 'user' | 'coordinator' },
  ): boolean {
    const manager = this.structuredManagerForTerminal(terminalId);
    if (!manager) return false;
    const pending = manager.getPending(terminalId);
    // W2-C: no live question, but one saved before a restart: the answer starts the thread again as a message that quotes it.
    if (!pending) return this.restoredQuestions?.answer(terminalId, requestId, opts) ?? false;
    if (opts.decision === 'allow') {
      const remappedAnswers = opts.answers ? this.remapAnswersToQuestionText(pending.questions, opts.answers) : undefined;
      const updatedInput = {
        ...(pending.input ?? {}),
        ...(pending.questions ? { questions: pending.questions } : {}),
        ...(remappedAnswers && Object.keys(remappedAnswers).length ? { answers: remappedAnswers } : {}),
      };
      const delivered = manager.answerPermission(terminalId, requestId || pending.requestId, { behavior: 'allow', updatedInput });
      if (delivered && pending.toolName === 'AskUserQuestion' && remappedAnswers) {
        this.logQuestionCardAnswer(terminalId, pending.questions, remappedAnswers, opts.logAs);
      }
      return delivered;
    }
    if (opts.canned && !manager.repliesToQuestions) {
      // This harness drops a deny's message (Codex) or is untested (Grok, OpenCode), so the fixed text would
      // never reach the model. Close the card with a plain deny, as before. Only a Dismiss is worth telling
      // a worker's coordinator about: a Discuss asked the agent to explain, and the agent never heard it.
      const delivered = manager.answerPermission(terminalId, requestId || pending.requestId, { behavior: 'deny', message: 'Denied' });
      if (delivered && opts.canned === 'dismiss') this.noteQuestionAnsweredInChat(terminalId, '', 0, 'dismiss');
      return delivered;
    }
    if (opts.canned) {
      // A card's Discuss-with-no-text or Dismiss: fixed text, logged as `canned` so a quote never matches it.
      const message = QUESTION_CANNED_MESSAGES[opts.canned];
      const delivered = manager.answerPermission(terminalId, requestId || pending.requestId, { behavior: 'deny', message });
      if (delivered) {
        this.logCoordinatorMessage(terminalId, message, 'canned');
        // A worker's coordinator was told to call answer_agent; tell it the user closed the card.
        this.noteQuestionAnsweredInChat(terminalId, '', 0, opts.canned);
      }
      return delivered;
    }
    return manager.answerPermission(terminalId, requestId || pending.requestId, { behavior: 'deny', message: opts.message || 'Denied' });
  }

  /**
   * A chat reply to a pending AskUserQuestion (the reply wording is fixed in question-reply.ts): resolve the question as a deny
   * whose message carries the reply, so the model reads it as the question's answer. Sent once,
   * never as a separate user turn. `imageCount` images go out afterwards as their own turn, because a deny can only carry text;
   * the caller sends them once this returns 'delivered'.
   * `from: 'chat'` is a Chat key's reply (never the human's words): other wording, a coordinator-source log row, no "the user answered" notice.
   *   'not-found'   — no question pending, or `requestId` is missing or names another one. No
   *                   fallback to "whatever is pending": that is the race guard.
   *   'unsupported' — this harness drops a deny's message (Codex) or is untested (Grok, OpenCode).
   *                   The caller sends the reply as a normal turn, today's behavior.
   * Logs the RAW reply as a `user` row (a ledger quote must match the user's own words; `from: 'chat'` logs `coordinator`
   * instead), and tells a worker's coordinator the question is answered (not for `from: 'chat'`).
   */
  answerQuestionInChat(terminalId: string, requestId: string, reply: string, imageCount = 0, from: 'user' | 'chat' = 'user'): 'delivered' | 'not-found' | 'unsupported' {
    const manager = this.structuredManagerForTerminal(terminalId);
    const pending = manager?.getPending(terminalId);
    // W2-C: a reply to a question saved before a restart goes out as one message that quotes the question.
    if (manager && !pending && requestId && this.restoredQuestions?.answer(terminalId, requestId, { reply, imageCount, from })) return 'delivered';
    if (!manager || !pending?.questions?.length || !requestId || pending.requestId !== requestId) return 'not-found';
    if (!manager.repliesToQuestions) return 'unsupported';
    const message = questionReplyMessage(reply, imageCount, from);
    if (!manager.answerPermission(terminalId, requestId, { behavior: 'deny', message })) return 'not-found';
    // A reply from Chat is not the human's: it is logged as a coordinator message, and nobody is told "the user answered".
    if (reply.trim()) this.logCoordinatorMessage(terminalId, reply, from === 'chat' ? 'coordinator' : 'user');
    if (from === 'user') this.noteQuestionAnsweredInChat(terminalId, reply, imageCount);
    return 'delivered';
  }

  /**
   * The user's answer to the overseer's OWN question card (AskUserQuestion) is the user's words,
   * but it never passes through sendStructuredMessage, so log it here (structured-recap spec,
   * Unit 1): one `user` row PER answered question, holding the answer ONLY. The overseer writes
   * the header and the question, so neither may become quotable evidence (a header "Merge" with
   * the answer "no" must not approve a merge), and each answer is its own message, so an "ok"
   * answer is a leading ok of that message. A multi-select answer arrives joined with ", "; a
   * free-text "Other" answer is kept verbatim. logCoordinatorMessage skips any thread that is not
   * a coordinator and never throws.
   */
  private logQuestionCardAnswer(terminalId: string, questions: any[] | undefined, answers: Record<string, unknown>, logAs: 'user' | 'coordinator' = 'user'): void {
    try {
      for (const q of Array.isArray(questions) ? questions : []) {
        const value = typeof q?.question === 'string' ? answers[q.question] : undefined;
        const answer = Array.isArray(value) ? value.map(String).join(', ') : typeof value === 'string' ? value : '';
        if (!answer.trim()) continue;
        this.logCoordinatorMessage(terminalId, answer, logAs);
      }
    } catch (err) {
      console.error(`coordinator message log: question-card answer not logged for ${terminalId}`, err); // the answer is already delivered
    }
  }
}
