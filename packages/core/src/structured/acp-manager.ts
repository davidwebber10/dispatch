// packages/core/src/structured/acp-manager.ts
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
import { pauseLabel } from '../limits/detect.js';
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
import { childEnv } from '../platform/inherited-env.js';
import { acpSmartAllows } from '../os/approvals.js';
import { EventRing } from './shared/event-ring.js';
import type { JournalRecorder, ThreadRecorder } from '../journal/recorder.js';
import { BlockDeltaCoalescer } from './shared/stream-compaction.js';
import { JsonRpcStdioClient, METHOD_NOT_FOUND, type RpcId } from './shared/jsonrpc-client.js';
import { settleTurn, type SettleDeps } from './shared/settle-turn.js';
import { StructuredEmitter } from './shared/events.js';

/**
 * Open one newline-delimited JSON-RPC channel to one ACP agent child (`grok agent stdio`,
 * `opencode acp`) and run the ACP `initialize` handshake (every request awaits `ready`). The
 * channel itself is the shared JsonRpcStdioClient; only the handshake and the wording are ACP's own.
 */
function openAgent(command: string, args: string[], cwd: string, env: Record<string, string>): JsonRpcStdioClient {
  const conn = JsonRpcStdioClient.spawn(command, args, { cwd, env }, {
    messages: {
      exited: 'grok agent exited',
      notConnected: 'grok agent not connected',
      timeout: (method) => `The agent did not answer ${method} in time. It may still take it: check the model shown.`,
    },
  });
  conn.start(async (c) => {
    await c.request('initialize', {
      protocolVersion: 1,
      // No fs capabilities: the agent must do its own file IO, never through the daemon.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'dispatch', title: 'Dispatch', version: '2.0.0' },
    });
  });
  return conn;
}

interface GrokSession {
  terminalId: string;
  conn: JsonRpcStdioClient;
  translator: GrokTranslator;
  /** The recent events for replay; its `lastPushAt` is IStructuredManager.lastFrameAt. */
  ring: EventRing;
  /** Keeps a closed block's text as one delta in the ring (ring only; see shared/stream-compaction.ts). */
  coalescer: BlockDeltaCoalescer;
  /** Writes the finished items of this session to the message journal (W3-D). Absent with no journal. */
  recorder?: ThreadRecorder;
  escalate: boolean;
  /** Smart approvals (os/approvals.ts): Grok asks per the static rule set; OpenCode's config already holds it. */
  smart?: boolean;
  /** The thread's working dir: smart rules allow reads and edits inside it only. */
  workDir?: string;
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

export class AcpStructuredSessionManager extends StructuredEmitter implements IStructuredManager {
  private sessions = new Map<string, GrokSession>();
  private defaultEnv: Record<string, string> = {};

  /** How long a model switch may wait for the agent (to be ready, and to answer): the settings lock of the thread waits behind it. */
  private readonly switchTimeoutMs: number;
  /** The declared-status chain of a turn end (shared/settle-turn.ts). `summary` is the translator's completed prose. */
  private readonly settleDeps: SettleDeps = {
    idle: (terminalId, detail) => { this.fire('idle', terminalId, detail); },
    needsHelp: (terminalId, detail) => { this.fire('needs-help', terminalId, detail); },
    withSummary: true,
  };

  constructor(private readonly dialect: 'grok' | 'opencode' = 'grok', opts: { switchTimeoutMs?: number } = {}) {
    super();
    this.switchTimeoutMs = opts.switchTimeoutMs ?? 15_000;
  }

  /** The message journal's recorder (W3-D). Set by the daemon; a manager with none writes no journal. */
  journal?: JournalRecorder;

  setDefaultEnv(env: Record<string, string>): void { this.defaultEnv = env; }

  spawn(terminalId: string, opts: StructuredSpawnOpts): number {
    if (this.sessions.has(terminalId)) this.kill(terminalId);
    const env = childEnv(this.defaultEnv, opts.env);
    const conn = openAgent(opts.command, opts.args, opts.workDir, env);
    const session: GrokSession = {
      terminalId,
      conn,
      translator: new GrokTranslator(this.dialect),
      ring: new EventRing(),
      coalescer: new BlockDeltaCoalescer(),
      escalate: opts.escalate ?? false,
      smart: opts.approvals === 'smart',
      workDir: opts.workDir,
      pending: null,
      pendingApproval: null,
      model: opts.model,
      loading: false,
      turnActive: false,
      limitSettled: false,
      ready: Promise.resolve(),
    };
    if (opts.seedEvents?.length) session.ring.seed(opts.seedEvents);
    // W3-D: each finished item goes to the message journal. ACP prose has no whole frame: a block is finished at its stop.
    // A resume replays the session's history: the journal takes it when it has no import mark for the session.
    session.recorder = this.journal?.attach(terminalId, session.ring, { wholeFrames: false, replaySession: opts.resumeId });
    this.sessions.set(terminalId, session);
    conn.on('notification', (method, params) => this.onFrame(session, { method, params }));
    conn.on('request', (method, id, params) => this.onServerRequest(session, method, id, params));
    conn.on('spawn-error', (err: unknown) => {
      if (this.sessions.get(terminalId) !== session) return;
      this.pushEvent(session, { type: 'system', subtype: 'spawn_error', message: String(err) });
      this.fire('failed', terminalId);
    });
    conn.on('exit', (code: number) => {
      // Only evict if this child is still the current session (a re-spawn may have replaced it).
      if (this.sessions.get(terminalId)?.conn !== conn) return;
      session.recorder?.close(); // W3-D: a block that streamed when the agent died is written
      session.pending = null;
      session.pendingApproval = null;
      this.sessions.delete(terminalId);
      this.fire('exit', terminalId, code);
    });
    session.ready = this.startSession(session, opts.resumeId, opts.workDir).catch((err) => {
      if (this.sessions.get(terminalId) !== session) return;
      this.pushEvent(session, { type: 'system', subtype: 'spawn_error', message: String(err) });
      this.fire('failed', terminalId);
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
      this.fire('session', session.terminalId, resumeId);
      session.loading = true;
      let loaded = false;
      try {
        const res = await session.conn.request('session/load', { sessionId: resumeId, cwd, mcpServers: [] });
        loaded = true;
        this.adoptModel(session, res);
      } finally {
        session.loading = false;
        // W3-D: the replayed history is in (or was ignored). Only a load that the agent answered
        // with no error was the whole history: a failed load writes no import mark, so the next
        // load completes it.
        session.recorder?.loadEnded(loaded);
      }
    } else {
      const res = await session.conn.request('session/new', { cwd, mcpServers: [] });
      const sessionId = res?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('session/new returned no sessionId');
      session.sessionId = sessionId;
      session.recorder?.sessionStarted(sessionId); // W3-D: the journal has this session from its first item
      this.adoptModel(session, res);
      this.fire('session', session.terminalId, sessionId);
    }
    // `resumed` tells the translator its cost baseline may be missing: usage_update's
    // cost is session-cumulative, and a fresh translator on an old session would
    // otherwise bill the whole pre-resume total as one turn's delta.
    this.applyActions(session, session.translator.init(session.model, { resumed: !!resumeId }));
    // After a resume: the replay emitted whole `assistant` events (which set the chat's
    // busy=true) and — by design — no per-turn result footers. Close the ring with the
    // synthetic settle the client swallows without rendering (same shape cc-sessions.ts
    // appends for Claude), or a revived thread sits on "Working…" forever.
    if (resumeId && session.ring.length) this.pushEvent(session, { type: 'result', subtype: 'backfill', is_error: false });
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
    // An agent that never gets ready, or never answers the switch, must not hold the thread's settings lock for ever. One
    // deadline covers both waits: the lock is held for at most one budget, not one for readiness and another for the answer.
    const deadline = Date.now() + this.switchTimeoutMs;
    const left = () => Math.max(1, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        session.ready,
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('The agent was not ready in time')), left()); timer.unref?.(); }),
      ]);
    } finally { clearTimeout(timer); }
    if (!session.sessionId) throw new Error('This thread has no session yet');
    let resolved = model;
    if (session.modelVia === 'config') {
      const res = await session.conn.request('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: model }, left());
      const now = Array.isArray(res?.configOptions) ? res.configOptions.find((o: any) => o?.id === 'model')?.currentValue : undefined;
      if (typeof now === 'string' && now) resolved = now;
    } else {
      const res = await session.conn.request('session/set_model', { sessionId: session.sessionId, modelId: model }, left());
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
    // W3-D: a frame of a session/load replay is history that the journal has already (see ThreadRecorder.beginReplay).
    const replay = session.loading;
    if (replay) session.recorder?.beginReplay();
    try { this.applyActions(session, session.translator.translate(frame, { replay })); } finally { if (replay) session.recorder?.endReplay(); }
  }

  private onServerRequest(session: GrokSession, method: string, id: RpcId, params: any): void {
    const actions = session.translator.translate({ method, params, id });
    if (!actions.some((a) => a.kind === 'approval')) { session.conn.respondError(id, METHOD_NOT_FOUND, 'unhandled server request'); return; }
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
          this.fire('failed', session.terminalId);
          break;
        case 'usage-limit':
          // A usage limit is a pause, not a failure: the limit service parks the thread and wakes it.
          session.turnActive = false;
          session.limitSettled = true;
          this.fire('scheduled', session.terminalId, pauseLabel(action.limit.kind, action.limit.resetsAt, Date.now(), undefined, 30 * 60_000));
          this.fire('usage-limit', session.terminalId, action.limit);
          break;
        case 'busy':
          this.fire('busy', session.terminalId);
          break;
        case 'idle':
        case 'needs-help':
          // The ACP turn boundary: the shared declared-status chain (shared/settle-turn.ts), the
          // same one as the Codex manager. `action.summary` is the translator's own completed-prose
          // stash, carried through so a card keeps a real outcome line (the Claude ring walk finds
          // only deltas here too). ACP names no turns, so no turn id is given: `turnActive` is
          // what keeps the prompt-response fallback (runTurn) from a second settle.
          session.turnActive = false;
          settleTurn(session, action, this.settleDeps);
          break;
        case 'approval':
          this.handleApproval(session, action);
          break;
      }
    }
  }

  /** The escalate/auto-allow membrane (same policy as the other managers): surface when
   *  supervised, else answer with the request's own allow option so the thread never blocks. */
  private handleApproval(session: GrokSession, action: Extract<GrokAction, { kind: 'approval' }>): void {
    // Smart approvals, RULE-BASED (os/approvals.ts acpSmartAllows): Grok runs reads/searches and edits
    // inside the project and a short list of safe commands; the rest asks. OpenCode applies the same
    // rules in its own config, so what it still asks for is surfaced.
    if (session.smart && !session.escalate && !action.alwaysSurface) {
      const allow = this.dialect === 'grok' && acpSmartAllows(action.toolKind, action.pending.toolName, action.pending.input, session.workDir ?? process.cwd());
      if (allow) { session.conn.respond(action.requestId, action.autoApprove); return; }
      session.pending = action.pending;
      session.pendingApproval = { requestId: action.requestId, options: action.options };
      this.fire('permission', session.terminalId, action.pending);
      return;
    }
    if (session.escalate || action.alwaysSurface) {
      session.pending = action.pending;
      session.pendingApproval = { requestId: action.requestId, options: action.options };
      this.fire('permission', session.terminalId, action.pending);
    } else {
      session.conn.respond(action.requestId, action.autoApprove);
    }
  }

  postEvent(terminalId: string, event: Record<string, unknown>): void {
    const session = this.sessions.get(terminalId);
    if (session) this.pushEvent(session, event);
  }

  private pushEvent(session: GrokSession, event: unknown): void {
    session.ring.push(event);
    session.coalescer.observe(session.ring, event); // ring only: the live emit below is the event as it came
    this.fire('event', session.terminalId, event);
    // A signed-out login (ACP's auth error, OpenCode's missing provider key): a typed event after it.
    const auth = authRequiredFrame(event, this.dialect, undefined);
    if (auth) {
      session.ring.push(auth);
      this.fire('event', session.terminalId, auth);
      this.fire('auth-required', session.terminalId, auth);
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
    if (!session.conn.alive || !session.sessionId) { this.fire('failed', session.terminalId); return; }
    session.turnActive = true;
    session.limitSettled = false;
    this.fire('busy', session.terminalId);
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
        this.fire('scheduled', session.terminalId, pauseLabel(limit.kind, limit.resetsAt, Date.now(), undefined, 30 * 60_000));
        this.fire('usage-limit', session.terminalId, limit);
      } else this.fire('failed', session.terminalId);
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
    this.fire('resolved', terminalId);
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
      this.fire('resolved', terminalId);
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

  lastFrameAt(terminalId: string): number | undefined { return this.sessions.get(terminalId)?.ring.lastPushAt; }
  getEvents(terminalId: string): unknown[] { return this.sessions.get(terminalId)?.ring.snapshot() ?? []; }
  /** The last ended turn's own texts (IStructuredManager.getTurnTexts): the closed prose blocks, not the ring's deltas. */
  getTurnTexts(terminalId: string): string[] | null { return this.sessions.get(terminalId)?.translator.lastTurnTexts() ?? null; }
  getEventsTail(terminalId: string, n: number): unknown[] { return this.sessions.get(terminalId)?.ring.tail(n) ?? []; }
  isAlive(terminalId: string): boolean { return this.sessions.has(terminalId); }

  kill(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    session.pending = null;
    session.pendingApproval = null;
    this.sessions.delete(terminalId);
    session.conn.close();
    session.recorder?.close(); // W3-D: a block that streams at a stop (of the thread, of the daemon) is written
    this.fire('exit', terminalId, 0);
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

/**
 * Back-compat alias: the class was renamed to `AcpStructuredSessionManager` when the file became
 * acp-manager.ts (it drives every ACP harness: Grok and OpenCode). Importers of the old name keep working.
 */
export { AcpStructuredSessionManager as GrokStructuredSessionManager };
