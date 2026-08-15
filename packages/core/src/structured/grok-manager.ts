// packages/core/src/structured/grok-manager.ts
//
// The Grok "Pretty" structured transport: a third IStructuredManager whose payload is the
// ACP protocol (`grok agent stdio`, JSON-RPC over stdio) instead of Claude's stream-json or
// Codex's app-server. It emits the SAME Claude-shaped events (see grok-translate.ts) so the
// SessionService, the structured ws, and the ChatView drive it identically to the other two.
//
// Connection model: ONE `grok agent stdio` child PER TERMINAL — unlike Codex's shared
// app-server. ACP itself multiplexes sessions over one connection, but Dispatch's per-thread
// MCP servers and hooks ride in a per-thread GROK_HOME (see providers/grok-home.ts), and an
// environment variable is process-level — a shared child could only ever carry ONE thread's
// injections. Per-terminal children match the PTY transport's resource shape exactly.
//
// Turn lifecycle: `session/prompt` BLOCKS until the turn ends (its response carries the
// stopReason), while `turn_completed` arrives as a notification just before. The translator
// owns the boundary (result footer + idle/needs-help); the response is only a FALLBACK for
// turns that end without the notification (a cancel, a protocol error) — finishTurn() below.
//
// Resume: `session/load` replays the whole history as ordinary session/update notifications
// before its response resolves. Frames translated while loading run in replay mode — whole
// events, no control actions — so the ring backfills without re-counting usage or re-firing
// turn boundaries (the exact hazard the Codex backfill solves with thread/read).
//
// ALL ACP↔Claude payload mapping lives in grok-translate.ts. This file is JSON-RPC plumbing
// + the escalate/auto-allow permission membrane (identical policy to the other managers).

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import * as readline from 'readline';
import type {
  IStructuredManager,
  StructuredSpawnOpts,
  ContentBlock,
  MessageSource,
  PendingPermission,
  PermissionDecision,
  StatusDeclaration,
} from './manager.js';
import { GrokTranslator, buildPermissionResponse, type AcpPermissionOption, type GrokAction } from './grok-translate.js';

const MAX_EVENTS = 5000;

type RpcId = string | number;

/**
 * One newline-delimited JSON-RPC channel to one `grok agent stdio` child. Handles the ACP
 * `initialize` handshake, request/response correlation, and fans server→client requests +
 * notifications out to the manager. Knows nothing about Grok payload shapes.
 */
class GrokConnection extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly rl: readline.Interface;
  private nextId = 1;
  private readonly pending = new Map<RpcId, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private resolveReady!: () => void;
  private rejectReady!: (e: any) => void;
  /** Resolves once `initialize` completes; every request awaits it. */
  readonly ready: Promise<void>;
  private closed = false;

  constructor(command: string, args: string[], cwd: string, env: Record<string, string>) {
    super();
    this.setMaxListeners(0);
    this.child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    this.child.stdin.on('error', () => {}); // suppress EPIPE if the child closes stdin while alive
    this.rl = readline.createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => this.onLine(line));
    this.child.on('exit', (code) => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('grok agent exited'));
      this.pending.clear();
      this.emit('exit', code ?? 0);
    });
    this.child.on('error', (err) => { this.emit('spawn-error', err); });
    this.ready = new Promise<void>((res, rej) => { this.resolveReady = res; this.rejectReady = rej; });
    void this.handshake();
  }

  get pid(): number { return this.child.pid ?? -1; }
  get alive(): boolean { return !this.closed; }

  private async handshake(): Promise<void> {
    try {
      await this.request('initialize', {
        protocolVersion: 1,
        // No fs capabilities: the agent must do its own file IO, never through the daemon.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'dispatch', title: 'Dispatch', version: '2.0.0' },
      });
      this.resolveReady();
    } catch (err) {
      this.rejectReady(err);
    }
  }

  private onLine(line: string): void {
    const s = line.trim();
    if (!s) return;
    let msg: any;
    try { msg = JSON.parse(s); } catch { return; } // skip non-JSON noise
    if (msg.id !== undefined && msg.method === undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error?.message || 'rpc error'));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && typeof msg.method === 'string') {
      this.emit('server-request', msg.method, msg.id, msg.params ?? {});
      return;
    }
    if (typeof msg.method === 'string') this.emit('notification', msg.method, msg.params ?? {});
  }

  request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error('grok agent not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writeRaw({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.writeRaw({ jsonrpc: '2.0', method, params });
  }

  /** Answer a server→client request, echoing its id. */
  respond(id: RpcId, result: unknown): void {
    if (this.closed) return;
    this.writeRaw({ jsonrpc: '2.0', id, result });
  }

  respondError(id: RpcId, message: string): void {
    if (this.closed) return;
    this.writeRaw({ jsonrpc: '2.0', id, error: { code: -32601, message } });
  }

  private writeRaw(obj: unknown): void {
    if (this.closed || !this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  close(): void {
    this.closed = true;
    try { this.rl.close(); } catch { /* noop */ }
    try { this.child.kill(); } catch { /* already gone */ }
  }
}

interface GrokSession {
  terminalId: string;
  conn: GrokConnection;
  translator: GrokTranslator;
  events: unknown[];
  escalate: boolean;
  pending: PendingPermission | null;
  /** The ACP request a surfaced `pending` answers (server req id + its options). */
  pendingApproval: { requestId: RpcId; options: AcpPermissionOption[] } | null;
  sessionId?: string;
  model?: string;
  /** True while session/load replays history — frames translate in replay mode. */
  loading: boolean;
  /** True from prompt-send until the translator (or the response fallback) settles the turn. */
  turnActive: boolean;
  /** Resolves once session/new|load has bound a sessionId; sends chain on it. */
  ready: Promise<void>;
  /** The agent's report_status declaration for the CURRENT turn (see manager.ts). */
  declared?: StatusDeclaration;
}

export class GrokStructuredSessionManager extends EventEmitter implements IStructuredManager {
  private sessions = new Map<string, GrokSession>();
  private defaultEnv: Record<string, string> = {};

  constructor() {
    super();
    this.setMaxListeners(0);
  }

  setDefaultEnv(env: Record<string, string>): void { this.defaultEnv = env; }

  spawn(terminalId: string, opts: StructuredSpawnOpts): number {
    if (this.sessions.has(terminalId)) this.kill(terminalId);
    const env = { ...process.env, ...this.defaultEnv, ...opts.env } as Record<string, string>;
    const conn = new GrokConnection(opts.command, opts.args, opts.workDir, env);
    const session: GrokSession = {
      terminalId,
      conn,
      translator: new GrokTranslator(),
      events: [],
      escalate: opts.escalate ?? false,
      pending: null,
      pendingApproval: null,
      model: opts.model,
      loading: false,
      turnActive: false,
      ready: Promise.resolve(),
    };
    if (opts.seedEvents?.length) {
      session.events.push(...opts.seedEvents);
      if (session.events.length > MAX_EVENTS) session.events.splice(0, session.events.length - MAX_EVENTS);
    }
    this.sessions.set(terminalId, session);
    conn.on('notification', (method: string, params: any) => this.onFrame(session, { method, params }));
    conn.on('server-request', (method: string, id: RpcId, params: any) => this.onServerRequest(session, method, id, params));
    conn.on('spawn-error', (err: unknown) => {
      this.pushEvent(session, { type: 'system', subtype: 'spawn_error', message: String(err) });
    });
    conn.on('exit', (code: number) => {
      // Only evict if this child is still the current session (a re-spawn may have replaced it).
      if (this.sessions.get(terminalId)?.conn === conn) {
        session.pending = null;
        session.pendingApproval = null;
        this.sessions.delete(terminalId);
      }
      this.emit('exit', terminalId, code);
    });
    session.ready = this.startSession(session, opts.resumeId, opts.workDir).catch((err) => {
      this.pushEvent(session, { type: 'system', subtype: 'spawn_error', message: String(err) });
    });
    return conn.pid;
  }

  /** Bind an ACP session: `session/load` (replaying history) on resume, else `session/new`. */
  private async startSession(session: GrokSession, resumeId: string | undefined, cwd: string): Promise<void> {
    await session.conn.ready;
    if (resumeId) {
      // The id is known up front, so bind + announce it before the load — replay frames and
      // an early ws connect both see a bound session.
      session.sessionId = resumeId;
      this.emit('session', session.terminalId, resumeId);
      session.loading = true;
      try {
        const res = await session.conn.request('session/load', { sessionId: resumeId, cwd, mcpServers: [] });
        if (res?.models?.currentModelId) session.model = res.models.currentModelId;
      } finally {
        session.loading = false;
      }
    } else {
      const res = await session.conn.request('session/new', { cwd, mcpServers: [] });
      const sessionId = res?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('session/new returned no sessionId');
      session.sessionId = sessionId;
      if (res?.models?.currentModelId) session.model = res.models.currentModelId;
      this.emit('session', session.terminalId, sessionId);
    }
    this.applyActions(session, session.translator.init(session.model));
  }

  // --- inbound -------------------------------------------------------------------------------

  private onFrame(session: GrokSession, frame: { method: string; params: any }): void {
    // A per-terminal child hosts exactly one ACP session; a frame naming a DIFFERENT session
    // id is foreign noise. Frames without a sessionId (global _x.ai/* chatter) pass through —
    // the translator ignores anything it doesn't recognize.
    const sid = frame.params?.sessionId;
    if (typeof sid === 'string' && session.sessionId && sid !== session.sessionId) return;
    this.applyActions(session, session.translator.translate(frame, { replay: session.loading }));
  }

  private onServerRequest(session: GrokSession, method: string, id: RpcId, params: any): void {
    const actions = session.translator.translate({ method, params, id });
    if (!actions.some((a) => a.kind === 'approval')) { session.conn.respondError(id, 'unhandled server request'); return; }
    this.applyActions(session, actions);
  }

  private applyActions(session: GrokSession, actions: GrokAction[]): void {
    for (const action of actions) {
      switch (action.kind) {
        case 'event':
          this.pushEvent(session, action.event);
          break;
        case 'busy':
          this.emit('busy', session.terminalId);
          break;
        case 'idle':
        case 'needs-help':
          session.turnActive = false;
          this.settleTurn(session, action);
          break;
        case 'approval':
          this.handleApproval(session, action);
          break;
      }
    }
  }

  /**
   * The Grok turn boundary — the SAME declared-status precedence chain as the Codex manager's
   * settleTurn (see codex-manager.ts for the full rationale):
   *   1. declared `needs_you`   → 'needs-help', inferred: false
   *   2. any other declaration  → 'idle', declared: true (+ state/blocker)
   *   3. translator said question → 'needs-help', inferred: true
   *   4. otherwise              → 'idle', declared: false
   * `action.summary` is the translator's own completed-prose stash, carried through so a Grok
   * card persists a real outcome line (the Claude ring-walk finds only deltas here too).
   */
  private settleTurn(session: GrokSession, action: Extract<GrokAction, { kind: 'idle' | 'needs-help' }>): void {
    const declared = session.declared;
    session.declared = undefined; // per-turn — must not leak into the next one
    const summary = 'summary' in action ? action.summary : undefined;
    if (declared?.state === 'needs_you') {
      this.emit('needs-help', session.terminalId, { ask: declared.ask ?? declared.summary, summary: declared.summary, inferred: false });
    } else if (declared) {
      const detail: { declared: true; state: 'done' | 'blocked'; blocker?: string; summary?: string } =
        { declared: true, state: declared.state as 'done' | 'blocked', summary };
      if (declared.state === 'blocked' && declared.blocker) detail.blocker = declared.blocker;
      this.emit('idle', session.terminalId, detail);
    } else if (action.kind === 'needs-help') {
      this.emit('needs-help', session.terminalId, { ask: action.ask, summary: action.summary, inferred: true });
    } else {
      this.emit('idle', session.terminalId, { declared: false, summary });
    }
  }

  /** The escalate/auto-allow membrane (same policy as the other managers): surface when
   *  supervised, else answer with the request's own allow option so the thread never blocks. */
  private handleApproval(session: GrokSession, action: Extract<GrokAction, { kind: 'approval' }>): void {
    if (session.escalate || action.alwaysSurface) {
      session.pending = action.pending;
      session.pendingApproval = { requestId: action.requestId, options: action.options };
      this.emit('permission', session.terminalId, action.pending);
    } else {
      session.conn.respond(action.requestId, action.autoApprove);
    }
  }

  private pushEvent(session: GrokSession, event: unknown): void {
    session.events.push(event);
    if (session.events.length > MAX_EVENTS) session.events.shift();
    this.emit('event', session.terminalId, event);
  }

  // --- IStructuredManager surface ------------------------------------------------------------

  sendMessage(terminalId: string, content: string | ContentBlock[], source?: MessageSource): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    // Synthetic user echo (same as the other managers): the live user_message_chunk is
    // deliberately ignored by the translator, so this is the one user bubble that renders.
    const echoContent: ContentBlock[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    const ev: any = { type: 'user', message: { role: 'user', content: echoContent } };
    if (source) ev.meta = { source };
    this.pushEvent(session, ev);
    this.emit('busy', terminalId);
    // Serialize turns: session/prompt blocks until the turn ends, and ACP has no steer — a
    // second send while a turn runs simply queues behind it on the ready chain.
    session.ready = session.ready.then(() => this.runTurn(session, content)).catch(() => { /* surfaced in runTurn */ });
  }

  private async runTurn(session: GrokSession, content: string | ContentBlock[]): Promise<void> {
    if (!session.conn.alive || !session.sessionId) return;
    session.turnActive = true;
    try {
      await session.conn.request('session/prompt', { sessionId: session.sessionId, prompt: toPrompt(content) });
    } catch (err) {
      this.pushEvent(session, { type: 'result', subtype: 'error', is_error: true, result: String(err) });
    }
    // Fallback boundary: normally turn_completed already settled this (turnActive false). A
    // cancel or an error response reaches here with the turn still open — settle it now so
    // the thread never sticks on "working".
    if (session.turnActive) {
      session.turnActive = false;
      this.settleTurn(session, { kind: 'idle', summary: '' });
    }
  }

  answerPermission(terminalId: string, requestId: string, decision: PermissionDecision): boolean {
    const session = this.sessions.get(terminalId);
    if (!session || !session.pending || !session.pendingApproval) return false;
    if (requestId && session.pending.requestId !== requestId) return false;
    session.conn.respond(session.pendingApproval.requestId, buildPermissionResponse(decision, session.pendingApproval.options));
    session.pending = null;
    session.pendingApproval = null;
    this.emit('resolved', terminalId);
    return true;
  }

  setEscalate(terminalId: string, escalate: boolean): boolean {
    const session = this.sessions.get(terminalId);
    if (!session) return false;
    session.escalate = escalate;
    // Going autonomous with a gated approval pending → allow it immediately, so a supervised
    // thread unblocks the moment the user flips the dial (same as the other managers).
    if (!escalate && session.pending && session.pendingApproval) {
      session.conn.respond(session.pendingApproval.requestId, buildPermissionResponse({ behavior: 'allow' }, session.pendingApproval.options));
      session.pending = null;
      session.pendingApproval = null;
      this.emit('resolved', terminalId);
    }
    return true;
  }

  interrupt(terminalId: string): boolean {
    const session = this.sessions.get(terminalId);
    if (!session || !session.conn.alive || !session.sessionId) return false;
    // ACP cancel is a NOTIFICATION; the in-flight session/prompt then resolves with
    // stopReason "cancelled", and runTurn's fallback settles the turn.
    session.conn.notify('session/cancel', { sessionId: session.sessionId });
    return true;
  }

  compact(terminalId: string): void {
    // ACP has no compaction call, and Grok exposes none over this channel yet. A silent
    // no-op mirrors how an unsupported slash-command would behave; the context indicator
    // simply keeps reporting the real fill.
    void terminalId;
  }

  noteDeclaredStatus(terminalId: string, decl: StatusDeclaration): void {
    const session = this.sessions.get(terminalId);
    if (session) session.declared = decl;
  }

  getPending(terminalId: string): PendingPermission | null { return this.sessions.get(terminalId)?.pending ?? null; }
  getSessionId(terminalId: string): string | undefined { return this.sessions.get(terminalId)?.sessionId; }
  getEvents(terminalId: string): unknown[] { return [...(this.sessions.get(terminalId)?.events ?? [])]; }
  getEventsTail(terminalId: string, n: number): unknown[] {
    const events = this.sessions.get(terminalId)?.events ?? [];
    return n >= events.length ? [...events] : events.slice(events.length - n);
  }
  isAlive(terminalId: string): boolean { return this.sessions.has(terminalId); }

  kill(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    session.pending = null;
    session.pendingApproval = null;
    this.sessions.delete(terminalId);
    session.conn.close();
    this.emit('exit', terminalId, 0);
  }

  killAll(): void { for (const id of [...this.sessions.keys()]) this.kill(id); }
}

/** Map a Claude turn payload onto ACP prompt content blocks. Grok reports
 *  `promptCapabilities.image: false`, so image blocks degrade to a text marker rather than
 *  being dropped silently. */
function toPrompt(content: string | ContentBlock[]): unknown[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const out: unknown[] = [];
  for (const b of content) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b.type === 'image') out.push({ type: 'text', text: '[image attached — this Grok channel cannot receive images]' });
  }
  return out.length ? out : [{ type: 'text', text: '' }];
}
