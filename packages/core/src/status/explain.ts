/**
 * "Why is this thread in this state" (engineering program W2-G).
 *
 * `explainThread` is a pure function: a table of rules, in order. The first rule that matches gives
 * the headline, its reasons and the next steps. It reads no database, no clock and no process; the
 * diagnostics route (`GET /api/terminals/:id/diagnostics`) collects the facts and passes them in.
 *
 * Metadata only. No prompt, no message body, no limit banner text and no question text goes in or out.
 */
import type { ThreadStatus } from './events.js';
import type { StallState } from '../runtime/stall-watchdog.js';

/** One row of `lifecycle_events`, as `StatusService.diagnostics` selects it (newest first). */
export interface LifecycleEventRow {
  event_type: string;
  generation: string | null;
  turn_id: string | null;
  observed_at: string;
  /** The stored terminal status (`working`, `waiting`, ...) when the row was written. */
  status: string | null;
  disposition: string;
}

/** A usage-limit pause of the thread (a row of `usage_limit_parks`, without the CLI's banner text). */
export interface ParkInfo {
  /** `parked`: waits for the reset. `woken`: Dispatch resumed the thread. `capped`: Dispatch gave up. */
  state: 'parked' | 'woken' | 'capped';
  provider: string;
  kind: string;
  /** Epoch ms of the reset, or null when the CLI gave no readable time. */
  resetsAt: number | null;
  /** Epoch ms of the next try to continue the thread. */
  wakeAt: number;
  attempts: number;
  /** Epoch ms of the start of the pause. */
  parkedAt: number;
}

/** One row of the delivery outbox (W2-C), seen from one thread. It never holds the body. */
export interface DeliveryInfo {
  id: number;
  /** `to`: the notice is for this thread. `from`: this thread is the sender. */
  direction: 'to' | 'from';
  /** The other thread: the sender of a `to` row, the target of a `from` row. */
  peerId: string | null;
  peerLabel: string | null;
  kind: string;
  state: 'pending' | 'delivered' | 'dropped';
  attempts: number;
  lastError: string | null;
  createdAt: string | null;
  deliveredAt: string | null;
}

export interface ExplainInput {
  status: ThreadStatus;
  /** The lifecycle record's open-turn flag. Null when no harness event keeps it for this thread. */
  turnOpen: boolean | null;
  /** Null when the daemon could not read the process state. */
  processAlive: boolean | null;
  transport: 'structured' | 'pty';
  /** Newest first. */
  lastEvents: LifecycleEventRow[];
  stall: StallState | null;
  park: ParkInfo | null;
  /** True when a question or an approval request of the thread is open or saved. */
  pendingQuestion: boolean;
  deliveries: DeliveryInfo[];
  /** Epoch ms. */
  now: number;
}

export type ExplainAction = 'reset-status' | 'restart' | 'open-usage' | 'none';
export interface NextStep { label: string; action: ExplainAction }

export interface Explanation {
  /** The id of the rule that matched. Stable; for tests and for `dispatch doctor --json` readers. */
  rule: string;
  headline: string;
  /** ISO time from which the state holds, or null when it is not known. */
  since: string | null;
  reasons: string[];
  nextSteps: NextStep[];
}

const RESET: NextStep = { label: 'Reset status', action: 'reset-status' };
const RESTART: NextStep = { label: 'Restart thread', action: 'restart' };
const USAGE: NextStep = { label: 'Open usage limits', action: 'open-usage' };

/** "under 1 min", "14 min", "2 h 5 min", "2 d 2 h". */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'under 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/** "2026-11-09 14:05 UTC". The daemon does not know the reader's time zone, so it names UTC. */
export function formatTime(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const peer = (d: DeliveryInfo): string => (d.peerId ? `the thread ${d.peerLabel ? `"${d.peerLabel}" (${d.peerId})` : d.peerId}` : 'a thread that is not known');
const kindName = (kind: string): string => (kind === 'notice' ? 'notice' : `${kind} notice`);
const article = (name: string): string => (/^[aeiou]/i.test(name) ? `An ${name}` : `A ${name}`);

/** The stored statuses a thread status is saved as (StatusService's TO_TERMINAL). */
const STORED: Record<ThreadStatus, string> = {
  queued: 'queued', starting: 'waiting', working: 'working', needs_input: 'needs_input',
  idle: 'waiting', done: 'waiting', error: 'error', scheduled: 'scheduled',
};

/**
 * The thread status behind a stored terminal status. The terminal row is what the owner sees, so it
 * decides; the lifecycle record only says which kind of "waiting" it is (idle, done or starting).
 */
export function threadStatusOf(terminalStatus: string, lifecycleStatus: string | null | undefined): ThreadStatus {
  switch (terminalStatus) {
    case 'queued': case 'working': case 'needs_input': case 'error': case 'scheduled': return terminalStatus;
    case 'waiting': return lifecycleStatus === 'done' || lifecycleStatus === 'starting' ? lifecycleStatus : 'idle';
    default: return 'idle';
  }
}

/** A row of `usage_limit_parks` without its banner text. Null for no row. */
export function toParkInfo(row: unknown): ParkInfo | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (r.state !== 'parked' && r.state !== 'woken' && r.state !== 'capped') return null;
  return {
    state: r.state, provider: String(r.provider ?? ''), kind: String(r.kind ?? 'usage'),
    resetsAt: typeof r.resets_at === 'number' ? r.resets_at : null,
    wakeAt: Number(r.wake_at ?? 0), attempts: Number(r.attempts ?? 0), parkedAt: Number(r.parked_at ?? 0),
  };
}

/**
 * An outbox row (W2-C) as one thread sees it. The row can use the table's column names or camel
 * case; the body is never copied. Null for a row that this function cannot read.
 */
export function toDeliveryInfo(row: unknown, terminalId: string, labelOf?: (id: string) => string | null): DeliveryInfo | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const text = (...keys: string[]): string | null => { for (const k of keys) if (typeof r[k] === 'string' && r[k]) return r[k] as string; return null; };
  const target = text('target_terminal_id', 'targetTerminalId', 'targetId');
  const source = text('source_terminal_id', 'sourceTerminalId', 'sourceId');
  const state = r.state;
  if (typeof r.id !== 'number' || !target || (state !== 'pending' && state !== 'delivered' && state !== 'dropped')) return null;
  const direction = target === terminalId ? 'to' : 'from';
  const peerId = direction === 'to' ? source : target;
  let peerLabel: string | null = null;
  if (peerId && labelOf) { try { peerLabel = labelOf(peerId); } catch { peerLabel = null; } }
  return {
    id: r.id, direction, peerId, peerLabel, kind: text('kind') ?? 'notice', state,
    attempts: Number(r.attempts ?? 0), lastError: text('last_error', 'lastError'),
    createdAt: text('created_at', 'createdAt'), deliveredAt: text('delivered_at', 'deliveredAt'),
  };
}

interface Verdict { headline: string; since?: string | null; reasons: string[]; nextSteps: NextStep[] }
interface Rule { id: string; when(i: ExplainInput): boolean; say(i: ExplainInput): Verdict }

const pendingOf = (i: ExplainInput): DeliveryInfo[] => i.deliveries.filter((d) => d.state === 'pending');
const resting = (i: ExplainInput): boolean => i.status === 'idle' || i.status === 'done';

/** The rules, in order. The first match wins. */
const RULES: Rule[] = [
  {
    id: 'parked-limit',
    when: (i) => i.park?.state === 'parked' && i.status !== 'working',
    say: (i) => {
      const p = i.park!;
      const reasons = [`The ${p.kind} limit of ${p.provider} stopped the thread.`];
      if (p.resetsAt === null) reasons.push(`The CLI gave no reset time that Dispatch could read. Dispatch tries again at ${formatTime(p.wakeAt)}.`);
      else reasons.push(`Dispatch sends a message to continue the thread at ${formatTime(p.wakeAt)} (in ${formatDuration(p.wakeAt - i.now)}).`);
      if (p.attempts > 0) reasons.push(`Dispatch resumed this thread ${plural(p.attempts, 'time')} already, and the limit stopped it again.`);
      reasons.push('A message from you ends the pause.');
      return {
        headline: p.resetsAt === null ? 'Paused on a usage limit; the reset time is not known' : `Paused on a usage limit until ${formatTime(p.resetsAt)}`,
        since: iso(p.parkedAt), reasons, nextSteps: [USAGE],
      };
    },
  },
  {
    id: 'capped-limit',
    when: (i) => i.park?.state === 'capped' && i.status !== 'working',
    say: (i) => ({
      headline: 'Stopped on a usage limit',
      since: iso(i.park!.parkedAt),
      reasons: [
        `The ${i.park!.kind} limit of ${i.park!.provider} stopped the thread.`,
        `Dispatch tried ${plural(i.park!.attempts, 'time')} and does not try again.`,
        'Send a message when the limit is over, or change the account of the thread.',
      ],
      nextSteps: [USAGE],
    }),
  },
  {
    id: 'queued',
    when: (i) => i.status === 'queued',
    say: () => ({
      headline: 'Queued: the thread did not start yet',
      reasons: ['The thread holds its task and has no process.', 'It starts when you start it, or when the thread that queued it starts it.'],
      nextSteps: [],
    }),
  },
  {
    id: 'working-dead-process',
    when: (i) => i.status === 'working' && i.processAlive === false,
    say: () => ({
      headline: 'Working, but the process ended',
      reasons: [
        'The status is "working", and no process runs for this thread.',
        'No event closed the turn, so the status did not change.',
        'Reset status sets the thread back to waiting. Restart thread starts the process again with the same conversation.',
      ],
      nextSteps: [RESET, RESTART],
    }),
  },
  {
    id: 'working-stalled',
    when: (i) => i.status === 'working' && !!i.stall,
    say: (i) => {
      const s = i.stall!;
      return {
        headline: `Working, but silent for ${formatDuration(i.now - s.stalledSince)}`,
        since: iso(s.stalledSince),
        reasons: [
          s.lastFrameAt === null
            ? 'The thread sent no output since Dispatch started to watch this turn.'
            : `The thread sent its last output at ${formatTime(s.lastFrameAt)}.`,
          'The watchdog only flags the thread. It does not stop the process and it does not change the status.',
          'A long tool call or a slow model can be the cause. The thread can still be at work.',
          ...(i.processAlive === true ? ['The process of the thread is alive.'] : []),
        ],
        nextSteps: [RESTART, RESET],
      };
    },
  },
  {
    id: 'working-no-open-turn',
    when: (i) => i.status === 'working' && i.transport === 'structured' && i.turnOpen === false,
    say: (i) => ({
      headline: 'Working, but no turn is open',
      reasons: [
        'The status is "working", and the lifecycle record shows no open turn.',
        'The status can be stale. A new turn corrects it. Reset status corrects it now.',
        ...(i.processAlive === true ? ['The process of the thread is alive.'] : []),
      ],
      nextSteps: [RESET],
    }),
  },
  {
    id: 'working',
    when: (i) => i.status === 'working',
    say: (i) => ({
      headline: 'Working: a turn is in progress',
      reasons: [i.processAlive === true ? 'The process of the thread is alive.' : 'Dispatch could not read the process state of the thread.'],
      nextSteps: [],
    }),
  },
  {
    id: 'needs-input-restored-question',
    when: (i) => i.status === 'needs_input' && i.pendingQuestion && i.processAlive === false,
    say: () => ({
      headline: 'Needs input: the question was kept across a restart',
      reasons: [
        'The process of the thread is not running. Dispatch saved the question.',
        'The question shows in the thread. Your answer starts the thread again.',
      ],
      nextSteps: [],
    }),
  },
  {
    id: 'needs-input-question',
    when: (i) => i.status === 'needs_input' && i.pendingQuestion,
    say: () => ({
      headline: 'Needs input: the thread waits for your answer',
      reasons: ['The thread asked a question or asked for an approval.', 'The question shows in the thread. The turn continues after your answer.'],
      nextSteps: [],
    }),
  },
  {
    id: 'needs-input-dead-process',
    when: (i) => i.status === 'needs_input' && i.processAlive === false,
    say: () => ({
      headline: 'Needs input, but the process ended',
      reasons: [
        'The status is "needs input", and no process runs for this thread.',
        'Dispatch holds no saved question for it, so there is nothing to answer.',
      ],
      nextSteps: [RESET, RESTART],
    }),
  },
  {
    id: 'needs-input-cli',
    when: (i) => i.status === 'needs_input' && i.transport === 'pty',
    say: () => ({
      headline: 'Needs input: the CLI waits for you',
      reasons: ['The CLI of the thread asks for an approval or an answer in its terminal.', 'Open the thread and answer there. If the terminal shows no question, reset the status.'],
      nextSteps: [RESET],
    }),
  },
  {
    id: 'needs-input-no-question',
    when: (i) => i.status === 'needs_input',
    say: () => ({
      headline: 'Needs input, but no open question is recorded',
      reasons: ['The status is "needs input", and Dispatch holds no open question for this thread.', 'If the thread shows no question, reset the status.'],
      nextSteps: [RESET],
    }),
  },
  {
    id: 'error-dead-process',
    when: (i) => i.status === 'error' && i.processAlive === false,
    say: () => ({
      headline: 'Error: the process ended with an error',
      reasons: ['The process of the thread stopped with an error code, or it stopped in the middle of a turn.', 'Restart thread starts the process again with the same conversation.'],
      nextSteps: [RESTART, RESET],
    }),
  },
  {
    id: 'error',
    when: (i) => i.status === 'error',
    say: (i) => ({
      headline: 'Error: the last turn failed',
      reasons: [
        'The harness reported a failure at the end of the turn.',
        ...(i.processAlive === true ? ['The process of the thread is alive. A new message starts a new turn.'] : []),
      ],
      nextSteps: [RESET, RESTART],
    }),
  },
  {
    id: 'scheduled-dead-process',
    when: (i) => i.status === 'scheduled' && i.processAlive === false,
    say: () => ({
      headline: 'Scheduled, but the process ended',
      reasons: ['The thread set a wake and ended its turn.', 'The wake lives in the process. No process runs for this thread, so the wake cannot fire.'],
      nextSteps: [RESTART, RESET],
    }),
  },
  {
    id: 'scheduled',
    when: (i) => i.status === 'scheduled',
    say: () => ({
      headline: 'Scheduled: the thread waits for a wake that it set',
      reasons: ['The thread set a wake and ended its turn. It starts a new turn at the wake time.'],
      nextSteps: [],
    }),
  },
  {
    id: 'starting',
    when: (i) => i.status === 'starting',
    say: () => ({
      headline: 'Starting: the process of the thread starts',
      reasons: ['The CLI started and no turn started yet.'],
      nextSteps: [],
    }),
  },
  {
    id: 'idle-pending-delivery',
    when: (i) => resting(i) && pendingOf(i).length > 0,
    say: (i) => ({
      headline: `Waiting, with ${plural(pendingOf(i).length, 'notice')} that ${pendingOf(i).length === 1 ? 'is' : 'are'} not delivered`,
      reasons: ['The thread has no open turn.'],
      nextSteps: [],
    }),
  },
  {
    id: 'done',
    when: (i) => i.status === 'done',
    say: () => ({
      headline: 'Done: the process ended normally',
      reasons: ['The process of the thread ended with no error. A new message starts it again.'],
      nextSteps: [],
    }),
  },
  {
    id: 'idle',
    when: () => true,
    say: (i) => ({
      headline: 'Waiting for your next message',
      reasons: [
        'The last turn ended and the thread has no open turn.',
        ...(i.processAlive === false ? ['No process runs for this thread. The next message starts it.'] : []),
      ],
      nextSteps: [],
    }),
  },
];

/** The start of the newest run of events that were written under the current status. */
function sinceOf(i: ExplainInput): string | null {
  const stored = STORED[i.status];
  let since: string | null = null;
  for (const e of i.lastEvents) {
    if (e.status !== stored) break;
    since = e.observed_at;
  }
  return since;
}

/** Facts that hold under every rule: resumed after a limit, each delivery that is not done, the last event. */
function commonReasons(i: ExplainInput): string[] {
  const out: string[] = [];
  if (i.park?.state === 'woken') out.push(`Dispatch resumed this thread after a usage limit (try ${Math.max(1, i.park.attempts)}).`);
  for (const d of i.deliveries) {
    const name = kindName(d.kind);
    if (d.state === 'pending') {
      out.push(d.direction === 'from'
        ? `${article(name)} for ${peer(d)} waits. Dispatch delivers it when that thread runs again (${plural(d.attempts, 'try')} so far).`
        : `${article(name)} from ${peer(d)} waits for this thread. Dispatch delivers it when the process of this thread runs again (${plural(d.attempts, 'try')} so far).`);
    } else if (d.state === 'dropped') {
      out.push(`${article(name)} ${d.direction === 'from' ? 'for' : 'from'} ${peer(d)} was dropped: ${d.lastError ?? 'no reason was saved'}.`);
    }
  }
  const last = i.lastEvents[0];
  if (last) {
    const at = Date.parse(last.observed_at);
    const rejected = last.disposition && !['applied', 'accepted', 'inferred'].includes(last.disposition) ? ` (not applied: ${last.disposition})` : '';
    out.push(`The last lifecycle event was ${last.event_type}${rejected}, ${Number.isFinite(at) ? `${formatDuration(i.now - at)} ago` : 'at a time that is not known'}.`);
  }
  return out;
}

export function explainThread(input: ExplainInput): Explanation {
  const rule = RULES.find((r) => r.when(input))!; // the last rule always matches
  const verdict = rule.say(input);
  return {
    rule: rule.id,
    headline: verdict.headline,
    since: verdict.since !== undefined ? verdict.since : sinceOf(input),
    reasons: [...verdict.reasons, ...commonReasons(input)],
    nextSteps: verdict.nextSteps,
  };
}
