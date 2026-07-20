// packages/core/src/structured/manager.ts
import { EventEmitter } from 'events';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';
import { looksLikeQuestion } from '../status/question.js';

/**
 * A gated tool/permission request the CLI is blocked on, awaiting a human call.
 * For an AskUserQuestion tool the `questions` array carries the prompt(s); for a
 * plain gated tool it's undefined and `input` holds the tool's arguments.
 */
export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: any;
  toolUseId?: string;
  questions?: any[];
}

/**
 * A content block in a structured `user` turn. A turn is either a plain string
 * (today's text-only path) or an array of these blocks — which lets a turn carry a
 * REAL image (base64 inline, so the model SEES it) alongside optional text, instead
 * of a path-reference text line.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } };

/** Who actually sent a turn: the human directly, or the coordinator via its agency tools. */
export type MessageSource = 'user' | 'coordinator';

/** What an agent declared about how its turn ended, via the report_status tool. */
export interface StatusDeclaration {
  state: 'done' | 'needs_you' | 'blocked';
  summary: string;
  ask?: string;
  blocker?: string;
}

interface Session {
  child: ChildProcessWithoutNullStreams;
  rl: readline.Interface;
  events: unknown[]; // ring of recent events for replay
  /** When true, gated tools are surfaced as a Need instead of auto-allowed. */
  escalate: boolean;
  /** The single in-flight permission request awaiting a human decision, if any. */
  pending: PendingPermission | null;
  /** The claude session_id parsed from the init/system event (for resume on restart). */
  sessionId?: string;
  /**
   * name+input of the most recent can_use_tool request seen in the CURRENT turn, reset
   * after each `result` boundary. Lets the `result` handler tell a turn that ended because
   * the agent called a wake-scheduler tool (see WAKE_TOOLS) apart from one that's actually
   * done — the last tool called before `result` is a reliable proxy for "why did this turn
   * end" since can_use_tool fires for every tool call regardless of escalate/auto-allow.
   */
  lastToolUse?: { name: string; input: unknown };
  /**
   * The `source` of the turn most recently sent to this session, awaiting resolution to a
   * real transcript uuid once its `result` boundary fires (see the `result` handler below
   * and sessions/service.ts's 'message-source' listener). Set on every sendMessage call
   * (including to undefined for an untagged send) so a later tagged turn never resolves
   * against a stale value; consumed (cleared) at the next `result`.
   */
  pendingSource?: MessageSource;
  /**
   * The agent's own declaration for the CURRENT turn, set by report_status and consumed
   * at the `result` boundary. Same lifecycle as lastToolUse: written mid-turn, read once
   * at turn end, then cleared. It must NOT be applied when the tool fires — `result`
   * lands afterwards and would overwrite it.
   */
  declared?: StatusDeclaration;
}

/** Options accepted by a structured manager's `spawn`. For the Claude manager
 *  `command`/`args` are the `claude` stream-json invocation; for a future Codex
 *  manager they identify how to reach its app-server — but the shape is shared so
 *  `SessionService.spawnStructured` can drive either without branching. */
export interface StructuredSpawnOpts {
  command: string;
  args: string[];
  workDir: string;
  env?: Record<string, string>;
  escalate?: boolean;
  seedEvents?: unknown[];
  /**
   * App-server-style managers (Codex) resume/model out-of-band over JSON-RPC rather than via
   * `args`: `resumeId` is the external thread id to `thread/resume`, `model` the thread's
   * model. The Claude manager encodes both in `command`/`args` (via buildStructuredCommand)
   * and ignores these — they're shared on the interface so `spawnStructured` drives either.
   */
  resumeId?: string;
  model?: string;
}

/** A permission decision written back to a blocked structured session. */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; message?: string };

/**
 * The shared structured-transport contract. Both the Claude stream-json manager
 * and (Phase B) the Codex app-server manager satisfy it, so `SessionService` and
 * the structured ws consume EITHER through this one interface — the frontend sees
 * the same Claude-shaped event stream regardless of which harness produced it.
 *
 * Emitted events (all Claude-shaped, `(terminalId, …)`):
 *   'event'  (terminalId, event)      — a stream event for the View/chat
 *   'session'(terminalId, sessionId)  — the external session/thread id to persist
 *   'permission'(terminalId, pending) — a gated tool/question awaiting a decision
 *   'idle'   (terminalId)             — a turn completed (thread is idle)
 *   'scheduled'(terminalId, activity) — turn ended by a wake-scheduler tool
 *   'needs-help'(terminalId, detail)  — turn ended needing the human (declared or inferred);
 *                                       detail: { ask: string; summary: string; inferred: boolean }
 *   'busy'   (terminalId)             — a turn started
 *   'resolved'(terminalId)            — a pending permission was answered
 *   'exit'   (terminalId, code)       — the backing process/connection exited
 *   'message-source'(terminalId, src) — a tagged turn's result landed (persist src)
 */
export interface IStructuredManager extends EventEmitter {
  setDefaultEnv(env: Record<string, string>): void;
  spawn(terminalId: string, opts: StructuredSpawnOpts): number;
  sendMessage(terminalId: string, content: string | ContentBlock[], source?: MessageSource): void;
  answerPermission(terminalId: string, requestId: string, decision: PermissionDecision): boolean;
  setEscalate(terminalId: string, escalate: boolean): boolean;
  interrupt(terminalId: string): boolean;
  compact(terminalId: string): void;
  noteDeclaredStatus(terminalId: string, decl: StatusDeclaration): void;
  getPending(terminalId: string): PendingPermission | null;
  getSessionId(terminalId: string): string | undefined;
  getEvents(terminalId: string): unknown[];
  getEventsTail(terminalId: string, n: number): unknown[];
  isAlive(terminalId: string): boolean;
  kill(terminalId: string): void;
  killAll(): void;
}

const MAX_EVENTS = 5000;

/**
 * Harness tools that deliberately END the current turn to sleep until a timer/event fires
 * (ScheduleWakeup after a delay, CronCreate on its next cron match) — unlike Monitor, which
 * blocks WITHIN the turn and never reaches this boundary. Seeing one as the last tool call
 * before `result` means the thread is dormant-but-will-resume, not finished.
 */
const WAKE_TOOLS = new Set(['ScheduleWakeup', 'CronCreate']);

/**
 * A short "why it's dormant" label built from the wake tool's own input. ScheduleWakeup
 * always carries a human-written `reason` (required by its schema); CronCreate has no
 * reason field, so fall back to its cron expression. Never throws — a malformed/missing
 * input just degrades to a generic label.
 */
function wakeActivity(toolName: string, input: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  if (toolName === 'ScheduleWakeup') {
    const reason = typeof inp.reason === 'string' && inp.reason.trim() ? inp.reason.trim() : undefined;
    return reason ? `Scheduled — ${reason}` : 'Scheduled — will resume automatically';
  }
  if (toolName === 'CronCreate') {
    const cron = typeof inp.cron === 'string' && inp.cron.trim() ? inp.cron.trim() : undefined;
    return cron ? `Scheduled — cron "${cron}"` : 'Scheduled — will resume automatically';
  }
  return 'Scheduled — will resume automatically';
}

/**
 * Drives one `claude` stream-json process per structured terminal. Parallel to
 * PTYManager but its payload is structured JSON events (not raw bytes), so it has
 * its own consumers (the structured ws + the View adapter) — it does NOT feed the
 * xterm/runner data path. Permissions are auto-allowed (parity with today).
 */
export class ClaudeStructuredSessionManager extends EventEmitter implements IStructuredManager {
  private sessions = new Map<string, Session>();
  private defaultEnv: Record<string, string> = {};

  constructor() {
    super();
    this.setMaxListeners(0); // Fix 4: many ws viewers each add an 'event' listener
  }

  setDefaultEnv(env: Record<string, string>): void { this.defaultEnv = env; }

  spawn(terminalId: string, opts: StructuredSpawnOpts): number {
    if (this.sessions.has(terminalId)) this.kill(terminalId);
    const child = spawn(opts.command, opts.args, {
      cwd: opts.workDir,
      env: { ...process.env, ...this.defaultEnv, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    child.stdin.on('error', () => {}); // Fix 2: suppress EPIPE if child closes stdin while alive

    const rl = readline.createInterface({ input: child.stdout });
    const session: Session = { child, rl, events: [], escalate: opts.escalate ?? false, pending: null };
    // Resume backfill: seed the ring with prior history (restored from the claude
    // transcript) BEFORE any live event lands, so a ws (re)connect replays the past
    // conversation first and the View isn't blank after a daemon restart.
    if (opts.seedEvents?.length) {
      session.events.push(...opts.seedEvents);
      if (session.events.length > MAX_EVENTS) session.events.splice(0, session.events.length - MAX_EVENTS);
    }
    this.sessions.set(terminalId, session);
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: any;
      try { event = JSON.parse(trimmed); } catch { return; } // skip non-JSON noise
      session.events.push(event);
      if (session.events.length > MAX_EVENTS) session.events.shift();
      // Capture the claude session_id (carried on the init/system event, and echoed
      // on later events). Surface it via a 'session' emit so the spawner can persist
      // it onto the terminal's external_id and resume this conversation after a restart.
      const sid: unknown = event?.session_id;
      if (typeof sid === 'string' && sid && session.sessionId !== sid) {
        session.sessionId = sid;
        this.emit('session', terminalId, sid);
      }
      if (event?.type === 'control_request' && event?.request?.subtype === 'can_use_tool') {
        const r = event.request;
        // Track regardless of the allow/deny path below — every tool call passes through
        // here (this membrane fires even when auto-allowing), so it's a reliable "last tool
        // called this turn" signal for the result-boundary wake check further down.
        if (typeof r?.tool_name === 'string') session.lastToolUse = { name: r.tool_name, input: r?.input };
        const questions = Array.isArray(r?.input?.questions) ? r.input.questions : undefined;
        // AskUserQuestion can't be auto-allowed — it needs a real `answers` map written back —
        // so it ALWAYS surfaces as pending, even on an otherwise-autonomous thread. (For an
        // agent the service then routes that pending UP to its coordinator rather than to the
        // human.) Every OTHER gated tool surfaces only when this thread escalates (the
        // supervised membrane); otherwise it's auto-allowed.
        const isAsk = r?.tool_name === 'AskUserQuestion' || questions !== undefined;
        if (session.escalate || isAsk) {
          // Do NOT auto-allow. Capture the pending decision and surface it so it can be
          // approved/denied (or an AskUserQuestion answered). The CLI stays blocked on stdin
          // until answerPermission() writes the response.
          const pending: PendingPermission = {
            requestId: event.request_id,
            toolName: r?.tool_name,
            input: r?.input,
            toolUseId: r?.tool_use_id,
            questions,
          };
          session.pending = pending;
          this.emit('permission', terminalId, pending);
        } else {
          // Auto-allow tool permission requests — parity with --dangerously-skip-permissions.
          this.write(terminalId, {
            type: 'control_response',
            response: { subtype: 'success', request_id: event.request_id, response: { behavior: 'allow', updatedInput: event.request.input } },
          });
        }
      }
      // Turn boundary: a `result` event ends the current turn. Three things can have
      // happened: the agent DECLARED how it ended (via report_status — see
      // noteDeclaredStatus/Session.declared), the LAST tool called this turn was a
      // wake-scheduler (see WAKE_TOOLS, meaning the agent deliberately ended its turn to
      // sleep until a timer/event fires, not because it's done), or neither — in which case
      // a text heuristic on the closing assistant message is the only signal left.
      // Consumers use 'idle' to settle status and, for an agent, push a completion notice to
      // its coordinator — 'scheduled' and 'needs-help' must NOT do either (the agent hasn't
      // finished, or is waiting on the human, not filed as done).
      if (event?.type === 'result') {
        const declared = session.declared;
        const wake = session.lastToolUse && WAKE_TOOLS.has(session.lastToolUse.name) ? session.lastToolUse : undefined;
        session.lastToolUse = undefined; // reset for the next turn
        session.declared = undefined;    // ditto — a declaration is per-turn

        // Declaration wins over everything: the agent told us, so don't guess.
        // `blocked` deliberately falls through to 'idle' — a thread waiting on another
        // agent still proceeds without the human, so it isn't a needs-help state.
        if (declared?.state === 'needs_you') {
          this.emit('needs-help', terminalId, { ask: declared.ask ?? declared.summary, summary: declared.summary, inferred: false });
        } else if (declared) {
          this.emit('idle', terminalId);
        } else if (wake) {
          this.emit('scheduled', terminalId, wakeActivity(wake.name, wake.input));
        } else {
          // Nothing declared. Read the closing text ONCE — this walks the event ring,
          // so calling it in both the condition and the body would scan it twice.
          const text = this.lastAssistantText(terminalId);
          if (looksLikeQuestion(text)) {
            // The case that used to be filed as finished. Marked inferred so it renders
            // as a guess and so the false-positive rate stays measurable.
            this.emit('needs-help', terminalId, { ask: text, summary: text, inferred: true });
          } else {
            this.emit('idle', terminalId);
          }
        }

        // The turn that just ended is now fully flushed to the transcript (result is always
        // the LAST thing the CLI writes for a turn) — so if it was sent with a source tag,
        // this is the earliest safe moment to resolve it to a real disk uuid (see
        // sessions/service.ts's 'message-source' listener, which does the disk read + persist).
        if (session.pendingSource) this.emit('message-source', terminalId, session.pendingSource);
        session.pendingSource = undefined;
      }
      this.emit('event', terminalId, event);
    });

    child.on('exit', (code) => {
      // Fix 1: only clear the map if this child is still the current session
      // (a re-spawn may have already replaced it; its exit must not evict the new child)
      if (this.sessions.get(terminalId)?.child === child) {
        session.pending = null; // drop any unanswered permission — the process is gone
        this.sessions.delete(terminalId);
      }
      this.emit('exit', terminalId, code ?? 0);
    });
    child.on('error', (err) => { this.emit('event', terminalId, { type: 'system', subtype: 'spawn_error', message: String(err) }); });

    return child.pid ?? -1;
  }

  private write(terminalId: string, obj: unknown): void {
    const s = this.sessions.get(terminalId);
    if (!s || !s.child.stdin.writable) return;
    s.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  // verified: persistent multi-turn over stdin on claude 2.1.195 — second user turn accepted and returned result on same process
  sendMessage(terminalId: string, content: string | ContentBlock[], source?: MessageSource): void {
    // Wire shape: a plain string is sent as `content: <string>` (the CLI's simplest
    // accepted shape, byte-identical to before); a block array is sent verbatim as
    // `content: [...blocks]` so a real image block reaches the model — it SEES the
    // picture, not a "Attached file: …" path line. `source` must never reach the CLI's
    // stdin (it would pollute the model's context with metadata about who's typing) — it's
    // only for the synthetic echo below (live UI) and, via `pendingSource`, for the durable
    // persist a caller does once this turn's `result` resolves it to a real uuid (see the
    // `result` handler above and sessions/service.ts's 'message-source' listener).
    this.write(terminalId, { type: 'user', message: { role: 'user', content } });
    // P0a: the CLI does NOT echo the user's turn back as an event, so buffer a
    // synthetic `user` event into the ring and emit it. Replay on ws reconnect then
    // restores the user's bubbles instead of leaving an assistant-only transcript.
    // Mirror the wire shape: a string becomes a single text block; blocks pass through
    // unchanged (so an image block re-renders inline via the chat's image parser).
    const echoContent: ContentBlock[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    const ev: { type: 'user'; message: { role: 'user'; content: ContentBlock[] }; meta?: { source: MessageSource } } =
      { type: 'user', message: { role: 'user', content: echoContent } };
    if (source) ev.meta = { source };
    const s = this.sessions.get(terminalId);
    if (s) {
      s.events.push(ev);
      if (s.events.length > MAX_EVENTS) s.events.shift();
      // Always overwritten (even to undefined for an untagged send) so a stale tag from a
      // prior turn can never leak onto this one's `result` resolution.
      s.pendingSource = source;
    }
    this.emit('event', terminalId, ev);
    // Turn start: delivering a message kicks off work → the thread is busy.
    this.emit('busy', terminalId);
  }

  /**
   * Trigger native Claude Code compaction: writes the same `/compact` slash-command
   * text a human would type, on the same stdin channel sendMessage uses. Unlike
   * sendMessage this does NOT buffer/emit a synthetic echo event — a "/compact"
   * bubble must never render in the chat. The CLI responds with a `system/status`
   * pair (`{status:"compacting"}` then `{status:null, compact_result:...}`) followed
   * by a fresh `system/init`, all forwarded verbatim through the normal 'event' path.
   */
  compact(terminalId: string): void {
    this.write(terminalId, { type: 'user', message: { role: 'user', content: '/compact' } });
  }

  /**
   * Record what the agent says about this turn. Stored, not applied — the `result`
   * handler reads it at the turn boundary. See Session.declared.
   */
  noteDeclaredStatus(terminalId: string, decl: StatusDeclaration): void {
    const s = this.sessions.get(terminalId);
    if (s) s.declared = decl;
  }

  /** The in-flight permission/question awaiting a human decision, or null. */
  getPending(terminalId: string): PendingPermission | null {
    return this.sessions.get(terminalId)?.pending ?? null;
  }

  /**
   * Resolve a pending gated-tool request by writing the control_response the CLI
   * is blocked on. `allow` carries `updatedInput` back to the tool (callers fold in
   * an AskUserQuestion `answers` map there); `deny` carries a `message`. Clears the
   * pending and emits 'resolved' so the thread's status can return to working.
   * Returns false when there's no matching pending (already answered / wrong id).
   */
  answerPermission(
    terminalId: string,
    requestId: string,
    decision: PermissionDecision,
  ): boolean {
    const s = this.sessions.get(terminalId);
    if (!s || !s.pending) return false;
    if (requestId && s.pending.requestId !== requestId) return false;
    const rid = s.pending.requestId;
    const response =
      decision.behavior === 'allow'
        ? { behavior: 'allow', updatedInput: decision.updatedInput ?? s.pending.input }
        : { behavior: 'deny', message: decision.message ?? 'Denied' };
    this.write(terminalId, {
      type: 'control_response',
      response: { subtype: 'success', request_id: rid, response },
    });
    s.pending = null;
    this.emit('resolved', terminalId);
    return true;
  }

  /**
   * Flip a live thread's escalation (the autonomy dial) without re-spawning.
   *   - escalate=true  → supervised: surface subsequent gated tools as Needs.
   *   - escalate=false → autonomous: auto-allow. Any PLAIN gated tool currently pending is
   *     resolved with `allow` immediately (so a thread blocked on the membrane unblocks the
   *     moment the user goes autonomous), and future ones auto-allow. A pending AskUserQuestion
   *     is left intact — it needs a real `answers` map, so it can't be silently auto-allowed.
   * Returns false when there's no live session for the terminal.
   */
  setEscalate(terminalId: string, escalate: boolean): boolean {
    const s = this.sessions.get(terminalId);
    if (!s) return false;
    s.escalate = escalate;
    if (!escalate && s.pending && !s.pending.questions) {
      const rid = s.pending.requestId;
      const updatedInput = s.pending.input;
      this.write(terminalId, {
        type: 'control_response',
        response: { subtype: 'success', request_id: rid, response: { behavior: 'allow', updatedInput } },
      });
      s.pending = null;
      this.emit('resolved', terminalId);
    }
    return true;
  }

  /**
   * Gracefully interrupt the current turn WITHOUT killing the process: send the
   * stream-json `interrupt` control on the same stdin channel the CLI uses for
   * control_responses. Mirrors how the CLI frames its own control_requests
   * (top-level `request_id` + `request.subtype`). The conversation stays alive and
   * can be steered/resumed afterwards. Returns false when there's no live session.
   */
  interrupt(terminalId: string): boolean {
    const s = this.sessions.get(terminalId);
    if (!s || !s.child.stdin.writable) return false;
    const requestId = `interrupt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.write(terminalId, { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } });
    return true;
  }

  kill(terminalId: string): void {
    const s = this.sessions.get(terminalId);
    if (!s) return;
    s.pending = null;
    s.rl.close(); // Fix 3: close readline so buffered lines stop emitting after kill
    try { s.child.kill(); } catch { /* already gone */ }
    this.sessions.delete(terminalId);
  }

  killAll(): void { for (const id of [...this.sessions.keys()]) this.kill(id); }

  isAlive(terminalId: string): boolean { return this.sessions.has(terminalId); }

  /** The claude session_id captured for a live thread (from its init event), or undefined. */
  getSessionId(terminalId: string): string | undefined { return this.sessions.get(terminalId)?.sessionId; }

  getEvents(terminalId: string): unknown[] { return [...(this.sessions.get(terminalId)?.events ?? [])]; } // Fix 4: return copy

  /**
   * The most recent assistant text in this session's event ring — what the turn ended
   * on. Mirrors SessionService.lastAssistantText, which reads the same ring from outside.
   */
  private lastAssistantText(terminalId: string, max = 2000): string {
    const events = this.sessions.get(terminalId)?.events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e: any = events[i];
      if (e?.type === 'assistant' && Array.isArray(e.message?.content)) {
        const text = e.message.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join('').trim();
        if (text) return text.length > max ? text.slice(0, max) : text;
      }
    }
    return '';
  }

  /** Like getEvents, but only the most recent `n` (or all, if the ring has fewer).
   *  Used to bound ws-connect replay — folding the full ring into a non-virtualized
   *  list is O(N) React reconciles and dominates chat-open latency on long threads. */
  getEventsTail(terminalId: string, n: number): unknown[] {
    const events = this.sessions.get(terminalId)?.events ?? [];
    return n >= events.length ? [...events] : events.slice(events.length - n);
  }
}

/**
 * Back-compat alias: the class was renamed to `ClaudeStructuredSessionManager`
 * when `IStructuredManager` was extracted (a second manager, `CodexStructured…`,
 * satisfies the same interface). Existing importers of the old name keep working.
 */
export { ClaudeStructuredSessionManager as StructuredSessionManager };
