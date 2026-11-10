/**
 * Durable boot recovery (engineering program W2-C). Two things a daemon restart lost without a word:
 *
 * 1. A scheduled wake. A thread that ended its turn with ScheduleWakeup / CronCreate is `scheduled`,
 *    and the wake lives in its process. The restart kills the process, so the wake never fires and
 *    the thread reads "scheduled" for ever. `reconcileAtBoot` flags it: a `wake.lost` lifecycle
 *    event, status idle with a fixed text, and a notice to its starter. It does not restart the thread.
 *    Only a wake that was scheduled under a daemon that ran this check is flagged (v4.5.0 review, I7):
 *    the threads that an earlier version left `scheduled` are a backlog, and a notice for each of them
 *    would start its coordinator and a turn on the first boot after the upgrade.
 *
 * 2. A pending question. The question a structured thread waits on lives in its manager's memory.
 *    Here it is written to `pending_questions` when it is asked and removed when it is resolved.
 *    After a restart the thread keeps `needs_input`, `SessionService.getPendingPermission` returns
 *    the saved payload (the same inline card as before), and an answer starts the thread again
 *    with one normal message that quotes the question.
 *
 * Everything here runs on an event (a manager event, a harness event, the boot). No timer.
 */
import type { EventEmitter } from 'events';
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import * as parksDb from '../db/usage-limits.js';
import * as pendingQuestionsDb from '../db/pending-questions.js';
import * as appState from '../db/app-state.js';
import { logLifecycle } from '../runtime/diagnostics.js';
import { resolveReportTarget } from './report-target.js';
import { stripControlChars } from './pty-message.js';
import { QUESTION_CANNED_MESSAGES, questionReplyMessage, type QuestionCannedAction } from './question-reply.js';
import type { DeliveryOutbox } from '../delivery/outbox.js';
import type { IStructuredManager, MessageSource, PendingPermission } from '../structured/manager.js';
import type { HarnessEvent } from '../runtime/events.js';

/** The activity text of a thread whose scheduled wake the restart killed. */
export const LOST_WAKE_ACTIVITY = 'A scheduled wake was lost when Dispatch restarted';

export interface BootReconcileDeps {
  db: Database.Database;
  /** True when a process backs the thread now (after the kickstart). */
  isAlive: (terminalId: string) => boolean;
  /** Sets the thread idle with an activity text (StatusService.markIdle). */
  markIdle: (terminalId: string, activity: string) => void;
  /** The lost-wake notice to the thread's starter goes through it. Absent: no notice. */
  outbox?: Pick<DeliveryOutbox, 'enqueue'>;
  /** When this daemon started (ms). Default: the time of the call. */
  startedAt?: number;
}

/**
 * `app_state` key: the start time (ms) of the last daemon that ended this check. A thread that became `scheduled`
 * at or after it did so under a daemon that ran the check, so its wake is one that a restart lost. Absent: no daemon
 * ran the check on this database yet (the first boot after the upgrade), and every `scheduled` thread is backlog.
 * It is written when the check ENDS, with the start time of the daemon: a daemon that stops before that changes
 * nothing, and the next one still flags what the daemon before it lost.
 */
export const LOST_WAKE_SINCE_KEY = 'boot.lost_wake_since';

function lostWakeSince(db: Database.Database): number | null {
  const raw = appState.get(db, LOST_WAKE_SINCE_KEY);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** When the thread became `scheduled` (ms): the time of its last status change, when that change was to `scheduled`. Null: not known. */
function scheduledAt(db: Database.Database, terminalId: string): number | null {
  const row = db.prepare('SELECT status, observed_at FROM thread_lifecycle WHERE terminal_id = ?').get(terminalId) as { status: string; observed_at: string } | undefined;
  if (!row || row.status !== 'scheduled') return null;
  const at = Date.parse(row.observed_at);
  return Number.isFinite(at) ? at : null;
}

function cfgOf(raw: string | null | undefined): Record<string, any> {
  try { return JSON.parse(raw || '{}') ?? {}; } catch { return {}; }
}

/** Who hears that this thread's wake was lost: its starter, or the overseer for an overseer worker. */
function lostWakeTarget(db: Database.Database, row: terminalsDb.TerminalRow): string | null {
  const target = resolveReportTarget(db, cfgOf(row.config));
  if (target.to === 'starter') return target.starterId;
  if (target.to !== 'overseer') return null;
  const coordinator = terminalsDb.listBySession(db, row.session_id)
    .find((t) => t.id !== row.id && !t.archived_at && t.type !== 'shell' && cfgOf(t.config).role === 'coordinator');
  return coordinator?.id ?? null;
}

/**
 * Called once in the boot `finally` block, after the kickstart and BEFORE
 * `StatusService.reconcileProcesses`: that call turns every `needs_input` thread with a dead
 * process into an error, and the caller must spare the ids in `restoredQuestions`.
 */
export function reconcileAtBoot(deps: BootReconcileDeps): { lostWakes: string[]; restoredQuestions: string[]; oldScheduled: string[] } {
  const { db } = deps;
  const startedAt = deps.startedAt ?? Date.now();
  const lostWakes: string[] = [];
  const restoredQuestions: string[] = [];
  /** Scheduled threads with a dead process that are older than the check: left as they are. */
  const oldScheduled: string[] = [];
  if (!db.open) return { lostWakes, restoredQuestions, oldScheduled };
  const since = lostWakeSince(db);

  // 1. Lost wakes. A thread paused for a usage limit is `scheduled` too, but the daemon resumes that one itself.
  let paused = new Set<string>();
  try { paused = new Set(parksDb.listPaused(db).map((p) => p.terminal_id)); } catch { /* no parks table: none paused */ }
  const scheduled = db.prepare("SELECT * FROM terminals WHERE archived_at IS NULL AND status = 'scheduled'").all() as terminalsDb.TerminalRow[];
  for (const row of scheduled) {
    if (paused.has(row.id) || deps.isAlive(row.id)) continue;
    // The backlog: scheduled before a daemon ran this check, or at a time that is not known. No event, no notice.
    const at = since === null ? null : scheduledAt(db, row.id);
    if (since === null || at === null || at < since) { oldScheduled.push(row.id); continue; }
    try {
      logLifecycle(db, { terminalId: row.id, type: 'wake.lost', observedAt: new Date().toISOString() }, 'applied');
      const event = db.prepare("SELECT MAX(id) AS id FROM lifecycle_events WHERE terminal_id = ? AND event_type = 'wake.lost'").get(row.id) as { id: number | null };
      deps.markIdle(row.id, LOST_WAKE_ACTIVITY);
      lostWakes.push(row.id);
      const targetId = lostWakeTarget(db, row);
      if (targetId && deps.outbox) {
        const label = stripControlChars(row.label || 'thread', { keepNewline: false });
        deps.outbox.enqueue({
          targetId,
          sourceId: row.id,
          kind: 'lost-wake',
          dedupKey: `lost-wake:${row.id}:${event.id ?? 0}`,
          body: `Thread "${label}" (${row.id}) waited for a wake it had scheduled, and its scheduled wake was lost when Dispatch restarted. `
            + 'The thread is idle now and will not resume on its own. If its work must continue, send it a message.',
        });
      }
    } catch (err) {
      console.warn(`[boot] lost-wake check failed for ${row.id}:`, err instanceof Error ? err.message : String(err));
    }
  }

  // 2. Saved questions. One whose thread is gone or no longer waits is stale; one whose process is dead is restored.
  for (const q of pendingQuestionsDb.list(db)) {
    const row = terminalsDb.getById(db, q.terminal_id);
    if (!row || (!row.archived_at && row.status !== 'needs_input')) { pendingQuestionsDb.remove(db, q.terminal_id); continue; }
    if (row.archived_at || deps.isAlive(row.id)) continue;
    restoredQuestions.push(row.id);
  }
  try { appState.set(db, LOST_WAKE_SINCE_KEY, String(startedAt)); } catch (err) {
    console.warn('[boot] could not record the lost-wake check:', err instanceof Error ? err.message : String(err));
  }
  return { lostWakes, restoredQuestions, oldScheduled };
}

/** The saved question of a thread that still waits on it (status needs_input), or null. */
export function restoredQuestion(db: Database.Database, terminalId: string): PendingPermission | null {
  if (!db.open) return null;
  const q = pendingQuestionsDb.get(db, terminalId);
  if (!q) return null;
  const row = terminalsDb.getById(db, terminalId);
  if (!row || row.archived_at || row.status !== 'needs_input') return null;
  try {
    const payload = JSON.parse(q.payload) as PendingPermission | null;
    return payload && Array.isArray(payload.questions) && payload.questions.length ? payload : null;
  } catch { return null; }
}

/** How a restored question was answered: the same inputs the live answer routes take. */
export interface RestoredAnswer {
  decision?: 'allow' | 'deny';
  answers?: Record<string, unknown>;
  message?: string;
  canned?: QuestionCannedAction;
  /** A typed reply in the thread's chat (answerQuestionInChat). */
  reply?: string;
  imageCount?: number;
  from?: 'user' | 'chat';
  logAs?: 'user' | 'coordinator';
}

/** What SessionService asks about a question that only the database still holds. */
export interface RestoredQuestions {
  get(terminalId: string): PendingPermission | null;
  /** Sends the answer as one message that quotes the question. False when there is no such question. Throws when the thread cannot start. */
  answer(terminalId: string, requestId: string, answer: RestoredAnswer): boolean;
}

const oneLine = (t: unknown) => stripControlChars(String(t ?? ''), { keepNewline: false }).trim();

/** The message the thread gets in place of the tool result its dead process waited for. It quotes the question. */
export function composeRestoredAnswer(question: PendingPermission, answer: RestoredAnswer): string {
  const qs = Array.isArray(question.questions) ? question.questions : [];
  const picked = answer.reply === undefined && !answer.canned && answer.decision === 'allow';
  const lines = [
    'Dispatch restarted while you waited for an answer to your question, so the question card closed before the answer could reach you. The question and the answer follow.',
    '',
  ];
  qs.forEach((q: any, i: number) => {
    const text = oneLine(q?.question);
    const header = oneLine(q?.header);
    lines.push(`Question${qs.length > 1 ? ` ${i + 1}` : ''}: ${header ? `[${header}] ` : ''}${text}`);
    const options = (Array.isArray(q?.options) ? q.options : []).map((o: any) => oneLine(typeof o === 'string' ? o : o?.label)).filter(Boolean);
    if (options.length) lines.push(`Options: ${options.join(' | ')}`);
    if (picked) {
      const value = answer.answers?.[q?.question] ?? (typeof q?.header === 'string' ? answer.answers?.[q.header] : undefined);
      const given = Array.isArray(value) ? value.map(oneLine).join(', ') : oneLine(value);
      lines.push(`Answer: ${given || '(no answer given)'}`);
    }
  });
  lines.push('');
  if (answer.reply !== undefined) lines.push(questionReplyMessage(answer.reply, answer.imageCount ?? 0, answer.from ?? 'user'));
  else if (answer.canned) lines.push(QUESTION_CANNED_MESSAGES[answer.canned]);
  else if (picked) lines.push('Treat this as the answer to your question and continue.');
  else lines.push(`The user declined to answer${answer.message && answer.message !== 'Denied' ? `: ${oneLine(answer.message)}` : '.'} Do not proceed on a guess.`);
  return lines.join('\n');
}

export interface AnswerRestoredDeps {
  db: Database.Database;
  /** Starts the thread if it is not running and sends the message (SessionService.sendStructuredMessage). */
  send: (terminalId: string, text: string, source: MessageSource) => void;
  /** Tells every viewer to drop the card. */
  cleared?: (terminalId: string) => void;
}

export function answerRestoredQuestion(deps: AnswerRestoredDeps, terminalId: string, requestId: string, answer: RestoredAnswer): boolean {
  const question = restoredQuestion(deps.db, terminalId);
  if (!question) return false;
  // The same race guard as a live question: an answer names the question it answers.
  if (requestId && question.requestId !== requestId) return false;
  const source: MessageSource = answer.from === 'chat' || answer.logAs === 'coordinator' ? 'coordinator' : 'user';
  deps.send(terminalId, composeRestoredAnswer(question, answer), source); // a throw keeps the question
  pendingQuestionsDb.remove(deps.db, terminalId);
  try { deps.cleared?.(terminalId); } catch { /* a viewer that misses it drops the card on its next connect */ }
  return true;
}

/** The parts of the services this wiring touches. */
interface QuestionSessions {
  setRestoredQuestions(r: RestoredQuestions): void;
  sendStructuredMessage(terminalId: string, content: string, source?: MessageSource): void;
  structuredManagerForTerminal(terminalId: string): IStructuredManager | undefined;
}
interface QuestionStatus { onHarnessCommitted(listener: (event: HarnessEvent) => void): void }

/**
 * Keeps `pending_questions` in step with the managers, and gives SessionService the saved
 * question for a thread whose manager has none. Called once per composition root, after the
 * managers are registered.
 *   - `permission` with a question: the row is written (a plain gated tool is not saved: its
 *     process is gone after a restart and nothing could take the decision).
 *   - `resolved` (answered, cancelled, stale at a turn end): the row is removed. A process exit
 *     does not emit it, so the row survives a daemon that stops or is killed.
 *   - a new turn of the thread with no live question: a saved question is stale; the row is removed.
 */
export function wireRestoredQuestions(db: Database.Database, sessions: QuestionSessions, managers: Iterable<IStructuredManager>, status: QuestionStatus): void {
  const all = [...managers];
  const safe = (what: string, fn: () => void) => {
    try { if (db.open) fn(); } catch (err) { console.warn(`[pending-questions] ${what} failed:`, err instanceof Error ? err.message : String(err)); }
  };
  for (const manager of all) {
    manager.on('permission', (id: string, pending: PendingPermission | null) => safe('save', () => {
      if (pending?.questions?.length) pendingQuestionsDb.put(db, id, pending.requestId ?? null, pending);
      else pendingQuestionsDb.remove(db, id);
    }));
    manager.on('resolved', (id: string) => safe('remove', () => { pendingQuestionsDb.remove(db, id); }));
  }
  status.onHarnessCommitted((event) => {
    if (event.type !== 'turn.started') return;
    safe('remove', () => { if (!all.some((m) => m.getPending(event.terminalId))) pendingQuestionsDb.remove(db, event.terminalId); });
  });
  sessions.setRestoredQuestions({
    get: (id) => restoredQuestion(db, id),
    answer: (id, requestId, answer) => answerRestoredQuestion({
      db,
      send: (tid, text, source) => sessions.sendStructuredMessage(tid, text, source),
      cleared: (tid) => { (sessions.structuredManagerForTerminal(tid) as unknown as EventEmitter | undefined)?.emit('permission-cleared', tid); },
    }, id, requestId, answer),
  });
}
