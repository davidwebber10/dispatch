// packages/core/src/structured/manager.ts
import { EventEmitter } from 'events';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';

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
}

const MAX_EVENTS = 5000;

/**
 * Drives one `claude` stream-json process per structured terminal. Parallel to
 * PTYManager but its payload is structured JSON events (not raw bytes), so it has
 * its own consumers (the structured ws + the View adapter) — it does NOT feed the
 * xterm/runner data path. Permissions are auto-allowed (parity with today).
 */
export class StructuredSessionManager extends EventEmitter {
  private sessions = new Map<string, Session>();
  private defaultEnv: Record<string, string> = {};

  constructor() {
    super();
    this.setMaxListeners(0); // Fix 4: many ws viewers each add an 'event' listener
  }

  setDefaultEnv(env: Record<string, string>): void { this.defaultEnv = env; }

  spawn(terminalId: string, opts: { command: string; args: string[]; workDir: string; env?: Record<string, string>; escalate?: boolean; seedEvents?: unknown[] }): number {
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
      // Turn boundary: a `result` event ends the current turn → the thread is idle.
      // Consumers use this to settle status (working → idle) and, for an agent, to push
      // a completion notice to its coordinator.
      if (event?.type === 'result') this.emit('idle', terminalId);
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
    // picture, not a "Attached file: …" path line. `source` is UI-only bookkeeping for the
    // synthetic echo below — it must never reach the CLI's stdin (it would pollute the
    // model's context with metadata about who's typing).
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
    }
    this.emit('event', terminalId, ev);
    // Turn start: delivering a message kicks off work → the thread is busy.
    this.emit('busy', terminalId);
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
    decision: { behavior: 'allow'; updatedInput?: unknown } | { behavior: 'deny'; message?: string },
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
}
