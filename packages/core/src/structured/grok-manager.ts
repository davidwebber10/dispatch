// packages/core/src/structured/grok-manager.ts
//
// The ACP "Pretty" structured transport: an IStructuredManager whose payload is the ACP
// protocol (JSON-RPC over stdio) instead of Claude's stream-json or Codex's app-server. It
// emits the SAME Claude-shaped events (see grok-translate.ts) so the SessionService, the
// structured ws, and the ChatView drive it identically to the other two.
//
// TWO harnesses ride this manager, one instance each: Grok (`grok agent stdio`) and
// OpenCode (`opencode acp`). The dialect differences are small and live where they belong:
// the translator handles OpenCode's usage_update, adoptModel() reads either bind-response
// shape, and runTurn() settles OpenCode's response-driven turn boundary (Grok's arrives as
// a turn_completed notification first, so the response path is its cancel/error fallback).
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

import { authRequiredFrame } from '../auth/auth-failure.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { pauseLabel } from '../limits/detect.js';
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
import { inheritedEnv } from '../platform/inherited-env.js';
import { killWithGrace } from '../platform/kill-grace.js';

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

  /** `timeoutMs` (optional) rejects AND drops the pending entry, so an agent that never answers cannot hold the caller. */
  request(method: string, params: unknown, timeoutMs?: number): Promise<any> {
    if (this.closed) return Promise.reject(new Error('grok agent not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (timeoutMs !== undefined) {
        const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`The agent did not answer ${method} in time`)); }, timeoutMs);
        timer.unref?.();
        this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      } else {
        this.pending.set(id, { resolve, reject });
      }
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
    killWithGrace(this.child); // SIGTERM, then SIGKILL if the CLI ignores it
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
  /** How this agent reported its model, so a switch uses the matching request: Grok's
   *  `models` block → `session/set_model`; OpenCode's `configOptions` → `session/set_config_option`. */
  modelVia?: 'models' | 'config';
  /** True while session/load replays history — frames translate in replay mode. */
  loading: boolean;
  /** True from prompt-send until the translator (or the response fallback) settles the turn. */
  turnActive: boolean;
  /** True once the running turn ended as a usage-limit pause: a prompt call that is then rejected adds no second outcome. */
  limitSettled: boolean;
  /** Resolves once session/new|load has bound a sessionId; sends chain on it. */
  ready: Promise<void>;
  /** The agent's report_status declaration for the CURRENT turn (see manager.ts). */
  declared?: StatusDeclaration;
}

export class GrokStructuredSessionManager extends EventEmitter implements IStructuredManager {
  private sessions = new Map<string, GrokSession>();
  private defaultEnv: Record<string, string> = {};

  /** How long a model switch may wait for the agent (to be ready, and to answer): the settings lock of the thread waits behind it. */
  private readonly switchTimeoutMs: number;

  constructor(private readonly dialect: 'grok' | 'opencode' = 'grok', opts: { switchTimeoutMs?: number } = {}) {
    super();
    this.setMaxListeners(0);
    this.switchTimeoutMs = opts.switchTimeoutMs ?? 15_000;
  }

  setDefaultEnv(env: Record<string, string>): void { this.defaultEnv = env; }

  spawn(terminalId: string, opts: StructuredSpawnOpts): number {
    if (this.sessions.has(terminalId)) this.kill(terminalId);
    const env = { ...inheritedEnv(), ...this.defaultEnv, ...opts.env } as Record<string, string>;
    const conn = new GrokConnection(opts.command, opts.args, opts.workDir, env);
    const session: GrokSession = {
      terminalId,
      conn,
      translator: new GrokTranslator(this.dialect),
      events: [],
      escalate: opts.escalate ?? false,
      pending: null,
      pendingApproval: null,
      model: opts.model,
      loading: false,
      turnActive: false,
      limitSettled: false,
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
      if (this.sessions.get(terminalId) !== session) return;
      this.pushEvent(session, { type: 'system', subtype: 'spawn_error', message: String(err) });
      this.emit('failed', terminalId);
    });
    conn.on('exit', (code: number) => {
      // Only evict if this child is still the current session (a re-spawn may have replaced it).
      if (this.sessions.get(terminalId)?.conn !== conn) return;
      session.pending = null;
      session.pendingApproval = null;
      this.sessions.delete(terminalId);
      this.emit('exit', terminalId, code);
    });
    session.ready = this.startSession(session, opts.resumeId, opts.workDir).catch((err) => {
      if (this.sessions.get(terminalId) !== session) return;
      this.pushEvent(session, { type: 'system', subtype: 'spawn_error', message: String(err) });
      this.emit('failed', terminalId);
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
        this.adoptModel(session, res);
      } finally {
        session.loading = false;
      }
    } else {
      const res = await session.conn.request('session/new', { cwd, mcpServers: [] });
      const sessionId = res?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('session/new returned no sessionId');
      session.sessionId = sessionId;
      this.adoptModel(session, res);
      this.emit('session', session.terminalId, sessionId);
    }
    // `resumed` tells the translator its cost baseline may be missing: usage_update's
    // cost is session-cumulative, and a fresh translator on an old session would
    // otherwise bill the whole pre-resume total as one turn's delta.
    this.applyActions(session, session.translator.init(session.model, { resumed: !!resumeId }));
    // After a resume: the replay emitted whole `assistant` events (which set the chat's
    // busy=true) and — by design — no per-turn result footers. Close the ring with the
    // synthetic settle the client swallows without rendering (same shape cc-sessions.ts
    // appends for Claude), or a revived thread sits on "Working…" forever.
    if (resumeId && session.events.length) this.pushEvent(session, { type: 'result', subtype: 'backfill', is_error: false });
  }

  /** The session's REAL model id from the bind response. Grok reports
   *  `models.currentModelId`; OpenCode reports a `configOptions` entry with id 'model'. */
  private adoptModel(session: GrokSession, res: any): void {
    const fromModels = res?.models?.currentModelId;
    const fromConfig = Array.isArray(res?.configOptions)
      ? res.configOptions.find((o: any) => o?.id === 'model')?.currentValue
      : undefined;
    const model = fromModels ?? fromConfig;
    if (typeof model === 'string' && model) session.model = model;
    if (typeof fromModels === 'string') session.modelVia = 'models';
    else if (typeof fromConfig === 'string') session.modelVia = 'config';
  }

  getModel(terminalId: string): string | undefined { return this.sessions.get(terminalId)?.model; }

  /**
   * Switch the live ACP session's model, keeping the conversation. Live-verified: grok 1.0.4
   * answers `session/set_model {sessionId, modelId}` with `{_meta:{model:{Ok:id}}}`; OpenCode
   * 1.18.34 answers `session/set_config_option {sessionId, configId:'model', value}` with the
   * updated configOptions (it also accepts set_model, but answers `{}`, so the config call is
   * the one that confirms). An agent that reported neither gets set_model, the ACP default.
   */
  async setModel(terminalId: string, model: string): Promise<string> {
    const session = this.sessions.get(terminalId);
    if (!session) throw new Error('This thread is not running');
    // An agent that never gets ready, or never answers the switch, must not hold the thread's settings lock for ever.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        session.ready,
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('The agent was not ready in time')), this.switchTimeoutMs); timer.unref?.(); }),
      ]);
    } finally { clearTimeout(timer); }
    if (!session.sessionId) throw new Error('This thread has no session yet');
    let resolved = model;
    if (session.modelVia === 'config') {
      const res = await session.conn.request('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: model }, this.switchTimeoutMs);
      const now = Array.isArray(res?.configOptions) ? res.configOptions.find((o: any) => o?.id === 'model')?.currentValue : undefined;
      if (typeof now === 'string' && now) resolved = now;
    } else {
      const res = await session.conn.request('session/set_model', { sessionId: session.sessionId, modelId: model }, this.switchTimeoutMs);
      const ok = res?._meta?.model?.Ok;
      if (typeof ok === 'string' && ok) resolved = ok;
    }
    if (this.sessions.get(terminalId) !== session) return resolved;
    session.model = resolved;
    session.translator.setModel(resolved);
    this.pushEvent(session, { type: 'system', subtype: 'model', model: resolved, switched: true });
    return resolved;
  }

  // --- inbound -------------------------------------------------------------------------------

  private onFrame(session: GrokSession, frame: { method: string; params: any }): void {
    // A per-terminal child hosts exactly one ACP session; a frame naming a DIFFERENT session
    // id is foreign noise. Frames without a sessionId (global _x.ai/* chatter) pass through —
    // the translator ignores anything it doesn't recognize.
    if (this.sessions.get(session.terminalId) !== session) return;
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
        case 'failed':
          session.turnActive = false;
          this.emit('failed', session.terminalId);
          break;
        case 'usage-limit':
          // A usage limit is a pause, not a failure: the limit service parks the thread and wakes it.
          session.turnActive = false;
          session.limitSettled = true;
          this.emit('scheduled', session.terminalId, pauseLabel(action.limit.kind, action.limit.resetsAt, Date.now(), undefined, 30 * 60_000));
          this.emit('usage-limit', session.terminalId, action.limit);
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
    // A signed-out login (ACP's auth error, OpenCode's missing provider key): a typed event after it.
    const auth = authRequiredFrame(event, this.dialect, undefined);
    if (auth) {
      session.events.push(auth);
      if (session.events.length > MAX_EVENTS) session.events.shift();
      this.emit('event', session.terminalId, auth);
      this.emit('auth-required', session.terminalId, auth);
    }
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
    // Serialize turns: session/prompt blocks until the turn ends, and ACP has no steer — a
    // second send while a turn runs simply queues behind it on the ready chain.
    session.ready = session.ready.then(() => this.runTurn(session, content)).catch(() => { /* surfaced in runTurn */ });
  }

  private async runTurn(session: GrokSession, content: string | ContentBlock[]): Promise<void> {
    if (this.sessions.get(session.terminalId) !== session) return;
    if (!session.conn.alive || !session.sessionId) { this.emit('failed', session.terminalId); return; }
    session.turnActive = true;
    session.limitSettled = false;
    this.emit('busy', session.terminalId);
    let result: unknown;
    try {
      result = await session.conn.request('session/prompt', { sessionId: session.sessionId, prompt: toPrompt(content) });
    } catch (err) {
      if (this.sessions.get(session.terminalId) !== session) return;
      if (session.limitSettled) { session.turnActive = false; return; } // the turn already ended as a pause
      const limit = session.translator.takePendingLimit(); // the retries ran out on a usage limit, then the call failed
      session.translator.abortTurn(); // the failed turn's prose must not join the next turn's texts
      this.pushEvent(session, { type: 'result', subtype: 'error', is_error: true, result: String(err) });
      session.turnActive = false;
      if (limit) {
        this.emit('scheduled', session.terminalId, pauseLabel(limit.kind, limit.resetsAt, Date.now(), undefined, 30 * 60_000));
        this.emit('usage-limit', session.terminalId, limit);
      } else this.emit('failed', session.terminalId);
      return;
    }
    // Response-driven boundary: OpenCode sends no turn_completed update — the prompt
    // RESPONSE (stopReason + usage) IS its turn end, translated into the same result
    // footer + idle/needs-help as Grok's notification path. On Grok, turn_completed
    // normally settled the turn already (turnActive false, nothing happens here); a
    // cancel or protocol error reaches here with the turn still open and now settles
    // with a real footer instead of a bare idle — the thread never sticks on "working".
    if (session.turnActive) {
      session.turnActive = false;
      this.applyActions(session, session.translator.promptResult(result));
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
  /** The last ended turn's own texts (IStructuredManager.getTurnTexts): the closed prose blocks, not the ring's deltas. */
  getTurnTexts(terminalId: string): string[] | null { return this.sessions.get(terminalId)?.translator.lastTurnTexts() ?? null; }
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

/** Map a Claude turn payload onto ACP prompt content blocks. Grok DECLARES
 *  `promptCapabilities.image: false`, but a live probe proved the channel accepts
 *  `{type:'image', data, mimeType}` and the model genuinely sees the picture — the
 *  declaration is stale, so base64 images pass through as real ACP image blocks. Only a
 *  url-source image (which ACP has no wire shape for) degrades to a text marker. */
function toPrompt(content: string | ContentBlock[]): unknown[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const out: unknown[] = [];
  for (const b of content) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b.type === 'image') {
      const src: any = b.source;
      if (src?.type === 'base64' && src.data) out.push({ type: 'image', data: src.data, mimeType: src.media_type });
      else out.push({ type: 'text', text: '[image attachment could not be delivered on this channel]' });
    }
  }
  return out.length ? out : [{ type: 'text', text: '' }];
}
