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

interface Session {
  child: ChildProcessWithoutNullStreams;
  rl: readline.Interface;
  events: unknown[]; // ring of recent events for replay
  /** When true, gated tools are surfaced as a Need instead of auto-allowed. */
  escalate: boolean;
  /** The single in-flight permission request awaiting a human decision, if any. */
  pending: PendingPermission | null;
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

  spawn(terminalId: string, opts: { command: string; args: string[]; workDir: string; env?: Record<string, string>; escalate?: boolean }): number {
    if (this.sessions.has(terminalId)) this.kill(terminalId);
    const child = spawn(opts.command, opts.args, {
      cwd: opts.workDir,
      env: { ...process.env, ...this.defaultEnv, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    child.stdin.on('error', () => {}); // Fix 2: suppress EPIPE if child closes stdin while alive

    const rl = readline.createInterface({ input: child.stdout });
    const session: Session = { child, rl, events: [], escalate: opts.escalate ?? false, pending: null };
    this.sessions.set(terminalId, session);
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: any;
      try { event = JSON.parse(trimmed); } catch { return; } // skip non-JSON noise
      session.events.push(event);
      if (session.events.length > MAX_EVENTS) session.events.shift();
      if (event?.type === 'control_request' && event?.request?.subtype === 'can_use_tool') {
        if (session.escalate) {
          // The membrane: do NOT auto-allow. Capture the pending decision and surface
          // it so the user can approve/deny (or answer an AskUserQuestion). The CLI
          // stays blocked on stdin until answerPermission() writes the response.
          const r = event.request;
          const questions = Array.isArray(r?.input?.questions) ? r.input.questions : undefined;
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
  sendMessage(terminalId: string, text: string): void {
    this.write(terminalId, { type: 'user', message: { role: 'user', content: text } });
    // P0a: the CLI does NOT echo the user's turn back as an event, so buffer a
    // synthetic `user` event into the ring (same trim) and emit it. Replay on ws
    // reconnect then restores the user's bubbles instead of leaving an
    // assistant-only transcript.
    const ev = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
    const s = this.sessions.get(terminalId);
    if (s) {
      s.events.push(ev);
      if (s.events.length > MAX_EVENTS) s.events.shift();
    }
    this.emit('event', terminalId, ev);
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

  getEvents(terminalId: string): unknown[] { return [...(this.sessions.get(terminalId)?.events ?? [])]; } // Fix 4: return copy
}
