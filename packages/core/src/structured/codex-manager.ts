// packages/core/src/structured/codex-manager.ts
//
// The Codex "Pretty" structured transport: a second IStructuredManager whose payload is the
// `codex app-server` v2 JSON-RPC protocol instead of Claude's stream-json. It satisfies the
// SAME interface + emits the SAME Claude-shaped events (see codex-translate.ts) so the
// SessionService, the structured ws, and the ChatView drive it identically to the Claude one.
//
// Connection model (spec §2): ONE shared `codex app-server` child for the whole daemon,
// multiplexed by ThreadId — the protocol is thread-multiplexed (one server, many threads,
// events tagged by threadId). Internal Map<terminalId, session>; a reverse Map<threadId,
// terminalId> routes inbound frames. Crash recovery: if the child exits, respawn it and
// `thread/resume` every live thread by its ThreadId.
//
// ALL Codex↔Claude payload mapping lives in codex-translate.ts. This file is JSON-RPC plumbing
// + the escalate/auto-allow permission membrane (identical policy to the Claude manager).

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
import { CodexTranslator, buildApprovalResponse, type ApprovalMethod, type TranslatedAction } from './codex-translate.js';
import { adaptForPolicy } from '../overseer/policy-adapter.js';
import { inheritedEnv } from '../platform/inherited-env.js';
import { EventRing } from './shared/event-ring.js';
import type { JournalRecorder, ThreadRecorder } from '../journal/recorder.js';
import { BlockDeltaCoalescer } from './shared/stream-compaction.js';
import { JsonRpcStdioClient, METHOD_NOT_FOUND, type RpcId } from './shared/jsonrpc-client.js';
import { settleTurn, type SettleDeps } from './shared/settle-turn.js';
import { StructuredEmitter } from './shared/events.js';

/**
 * The app-server ANSWERED a request with an error: a refusal (an effort or a model it does not take). Distinct from a
 * transport failure ('app-server exited', 'not connected', a timeout), which says nothing about the request's content.
 */
export class CodexRpcError extends Error {}

/**
 * Open the single shared newline-delimited JSON-RPC channel to a `codex app-server` child and run
 * its `initialize` handshake (every request awaits `ready`). The channel itself is the shared
 * JsonRpcStdioClient; only the handshake, the refusal class and the wording are Codex's own.
 */
function openAppServer(spec: { command: string; args: string[]; cwd: string; env: Record<string, string> }): JsonRpcStdioClient {
  const conn = JsonRpcStdioClient.spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env }, {
    rpcError: (message) => new CodexRpcError(message),
    messages: { exited: 'app-server exited', notConnected: 'app-server not connected', timeout: (method) => `${method} timed out` },
  });
  conn.start(async (c) => {
    await c.request('initialize', {
      clientInfo: { name: 'dispatch', title: 'Dispatch', version: '2.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    c.notify('initialized', undefined);
  });
  return conn;
}

interface CodexSession {
  terminalId: string;
  translator: CodexTranslator;
  /** The recent events for replay; its `lastPushAt` is IStructuredManager.lastFrameAt. */
  ring: EventRing;
  /** Keeps a closed block's text as one delta in the ring (ring only; see shared/stream-compaction.ts). */
  coalescer: BlockDeltaCoalescer;
  /** Writes the finished items of this session to the message journal (W3-D). Absent with no journal. */
  recorder?: ThreadRecorder;
  escalate: boolean;
  pending: PendingPermission | null;
  /** The Codex ServerRequest a surfaced `pending` corresponds to (method + server req id). */
  pendingApproval: { method: ApprovalMethod; requestId: RpcId } | null;
  threadId?: string;
  currentTurnId?: string;
  turnActive: boolean;
  sessionId?: string;
  model?: string;
  /** The account the thread runs on (StructuredSpawnOpts.accountId), for auth_required. */
  accountId?: string;
  /** A model picked with setModel, sent as `model` on the next turn/start (then cleared). */
  nextTurnModel?: string;
  /** The model before the first pick that is still waiting for a turn: where a refused pick goes back to. */
  modelBeforePick?: string;
  /** The effort the owner picked (setEffort, or the saved one at spawn). Sent with EVERY turn/start: live-checked on
   *  codex-cli 0.166, a thread keeps the effort of its last turn when the model changes, and forgets it on resume. */
  pickedEffort?: string;
  cwd: string;
  resumeId?: string;
  /** The thread's persona (+ peer/tools block), sent as `developerInstructions` on `thread/start`
   *  (see StructuredSpawnOpts.systemPrompt). Also resent on `thread/resume`, but codex-cli 0.156.1
   *  ignores it there — a resumed thread keeps the persona from its own history (see startThread). */
  systemPrompt?: string;
  /** Optional per-session tool policy consulted before the escalate/auto-allow membrane; a
   *  deny is written straight back to Codex (no pending, no human involvement) — same
   *  contract as the Claude manager's Session.toolPolicy (see manager.ts). */
  toolPolicy?: (toolName: string, input: unknown) => { allow: true } | { allow: false; message: string };
  /** Per-spawn override of the manager-wide approval/sandbox default (see StructuredSpawnOpts
   *  and CodexManagerOptions) — undefined falls back to `this.approvalPolicy`/`this.sandbox`.
   *  Carried on BOTH a fresh `thread/start` and a crash-recovery `thread/resume` so a governed
   *  (e.g. coordinator) thread never silently reverts to the manager default after the shared
   *  app-server child restarts. */
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Per-thread config overrides (StructuredSpawnOpts.threadConfig) — the thread's own MCP
   *  identity. Sent on thread/start AND thread/resume, because crash recovery resumes every live
   *  thread on a FRESH app-server, which must start this thread's MCP servers again. */
  threadConfig?: Record<string, unknown>;
  /** toolUseId → the policy reason a governed thread's approval was declined with, until Codex's
   *  own completion of that item arrives (see declineWithReason / withDenyReason). */
  deniedReasons: Map<string, string>;
  /** Bumped by every startThread attempt; a failure from a superseded attempt (the app-server died
   *  mid-start and crash recovery began a new one) or from an ended session is ignored. */
  startGen: number;
  /** Resolves once thread/start|resume has assigned a threadId; sends chain on it. */
  ready: Promise<void>;
  /**
   * The agent's own declaration for the CURRENT turn, set by report_status. Same lifecycle as
   * the Claude manager's Session.declared: written mid-turn, read once at the turn boundary
   * (settleTurn), then cleared. See ClaudeStructuredSessionManager's `result` handler for the
   * precedence chain this mirrors (minus the wake branch — Codex has no WAKE_TOOLS tracking).
   */
  declared?: StatusDeclaration;
}

/** Approval policy + sandbox the manager starts every thread with, UNLESS a spawn overrides them
 *  per-thread (see StructuredSpawnOpts.approvalPolicy/sandbox, consulted in startThread below —
 *  e.g. service.ts pins a codex COORDINATOR thread to `'on-request'`/`'read-only'` regardless of
 *  this manager-wide default, so the Task 5 enforcement membrane actually fires on it). Defaults
 *  are permissive enough for real work (workspace writes allowed) while still routing
 *  escalations through the membrane; the E2E harness passes `read-only` to force an approval
 *  deterministically.
 *
 *  Wire literals verified against the REAL installed `codex app-server` (codex-cli 0.155.1):
 *  live probe (thread/start accepted `approvalPolicy: 'on-request'` + `sandbox: 'read-only'`,
 *  and a `git commit` under that pair surfaced a real `item/commandExecution/requestApproval`
 *  ServerRequest before the read-only sandbox itself blocked the write) AND `codex app-server
 *  generate-ts`'s own protocol bindings (`AskForApproval` = `'untrusted' | 'on-request' |
 *  { granular: {...} } | 'never'`; `SandboxMode` = `'read-only' | 'workspace-write' |
 *  'danger-full-access'`) — both confirm the literals below (including `'untrusted'`, which an
 *  earlier task brief mistakenly flagged for renaming to a camelCase form the CLI does not
 *  actually accept) are exactly right; nothing here needed correcting. */
export interface CodexManagerOptions {
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** How long a `thread/unsubscribe` may stay unanswered before we stop waiting (default 5s). */
  releaseTimeoutMs?: number;
  /** How long `loadModelEfforts` waits for the app-server to be ready and to answer `model/list` (default 5s). */
  modelListTimeoutMs?: number;
}

export class CodexStructuredSessionManager extends StructuredEmitter implements IStructuredManager {
  private sessions = new Map<string, CodexSession>();
  private threadToTerminal = new Map<string, string>();
  private conn?: JsonRpcStdioClient;
  private connSpec?: { command: string; args: string[]; cwd: string; env: Record<string, string> };
  private defaultEnv: Record<string, string> = {};
  private readonly approvalPolicy: 'untrusted' | 'on-request' | 'never';
  private readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  private readonly releaseTimeoutMs: number;
  private readonly modelListTimeoutMs: number;
  private effortCache?: { at: number; map: Record<string, string[]>; defaults: Record<string, string> };
  /** The declared-status chain of a turn end (shared/settle-turn.ts). `summary` is the completed agentMessage text. */
  private readonly settleDeps: SettleDeps = {
    idle: (terminalId, detail) => { this.fire('idle', terminalId, detail); },
    needsHelp: (terminalId, detail) => { this.fire('needs-help', terminalId, detail); },
    withSummary: true,
  };

  constructor(opts: CodexManagerOptions = {}) {
    super();
    this.releaseTimeoutMs = opts.releaseTimeoutMs ?? 5000;
    this.modelListTimeoutMs = opts.modelListTimeoutMs ?? 5000;
    this.approvalPolicy = opts.approvalPolicy ?? 'on-request';
    this.sandbox = opts.sandbox ?? 'workspace-write';
  }

  /** The message journal's recorder (W3-D). Set by the daemon; a manager with none writes no journal. */
  journal?: JournalRecorder;

  setDefaultEnv(env: Record<string, string>): void { this.defaultEnv = env; }

  spawn(terminalId: string, opts: StructuredSpawnOpts): number {
    // One native thread, one live owner. codex-cli (0.156.1, live-verified) ACCEPTS a second
    // thread/resume of a thread that is already loaded, and bindThread would then route that
    // thread's notifications AND approvals to the newer terminal — which carries none of the
    // owner's toolPolicy (a coordinator's membrane, bypassed). Checked before anything changes, so
    // a refusal leaves the owner untouched; the owner itself may respawn (a revive).
    if (opts.resumeId) {
      const owner = this.ownerOf(opts.resumeId);
      if (owner && owner !== terminalId) {
        throw new Error(`Codex thread ${opts.resumeId} is already open in another Dispatch thread — close that one first`);
      }
    }
    if (this.sessions.has(terminalId)) this.kill(terminalId);
    const conn = this.ensureConnection(opts);
    const session: CodexSession = {
      terminalId,
      accountId: opts.accountId,
      translator: new CodexTranslator(),
      ring: new EventRing(),
      coalescer: new BlockDeltaCoalescer(),
      escalate: opts.escalate ?? false,
      pending: null,
      pendingApproval: null,
      turnActive: false,
      cwd: opts.workDir,
      model: opts.model,
      pickedEffort: opts.effort,
      resumeId: opts.resumeId,
      systemPrompt: opts.systemPrompt,
      toolPolicy: opts.toolPolicy,
      approvalPolicy: opts.approvalPolicy,
      sandbox: opts.sandbox,
      threadConfig: opts.threadConfig,
      deniedReasons: new Map(),
      startGen: 0,
      ready: Promise.resolve(),
    };
    if (opts.seedEvents?.length) session.ring.seed(opts.seedEvents);
    // W3-D: each finished item goes to the message journal. Codex prose has no whole frame: a block is finished at its stop.
    session.recorder = this.journal?.attach(terminalId, session.ring, { wholeFrames: false });
    this.sessions.set(terminalId, session);
    session.ready = this.beginThread(session, conn);
    return conn.pid;
  }

  /** Lazily create the ONE shared app-server connection (first spawn wins its command/env — which
   *  is why nothing thread-specific may ride them: each thread's own MCP identity travels in its
   *  thread/start + thread/resume `config` instead; see CodexSession.threadConfig). */
  private ensureConnection(opts: StructuredSpawnOpts): JsonRpcStdioClient {
    if (this.conn?.alive) return this.conn;
    const env = { ...inheritedEnv(), ...this.defaultEnv, ...opts.env } as Record<string, string>;
    this.connSpec = { command: opts.command, args: opts.args, cwd: opts.workDir, env };
    this.conn = this.makeConnection(this.connSpec);
    return this.conn;
  }

  private makeConnection(spec: { command: string; args: string[]; cwd: string; env: Record<string, string> }): JsonRpcStdioClient {
    const conn = openAppServer(spec);
    conn.on('notification', (method, params) => { if (this.conn === conn) this.onNotification(method, params); });
    conn.on('request', (method, id, params) => this.onServerRequest(method, id, params));
    conn.on('exit', () => this.onConnExit(conn));
    return conn;
  }

  /** Run startThread for a session; its failure is reported unless the attempt was superseded by
   *  crash recovery or the session has ended (kill) in the meantime. */
  private beginThread(session: CodexSession, conn: JsonRpcStdioClient): Promise<void> {
    const gen = ++session.startGen;
    return this.startThread(session, conn).catch((err) => {
      if (session.startGen !== gen || this.sessions.get(session.terminalId) !== session) return;
      this.pushEvent(session, { type: 'system', subtype: 'spawn_error', message: String(err) });
      this.fire('failed', session.terminalId);
    });
  }

  /** Start (or resume) the thread for a session, then bind its threadId for routing. */
  private async startThread(session: CodexSession, conn: JsonRpcStdioClient): Promise<void> {
    await conn.ready;
    if (session.resumeId) {
      const res = await conn.request('thread/resume', {
        threadId: session.resumeId,
        cwd: session.cwd,
        model: session.model ?? null,
        // Carry a governed thread's per-spawn override through crash recovery too — otherwise a
        // coordinator resumed after the shared app-server child restarts would silently fall
        // back to the manager-wide default (see CodexSession.approvalPolicy/sandbox doc comment).
        approvalPolicy: session.approvalPolicy ?? this.approvalPolicy,
        sandbox: session.sandbox ?? this.sandbox,
        ...governedReviewer(session),
        ...threadConfigParam(session),
        // Resent for completeness, but NOT load-bearing: live-verified on codex-cli 0.156.1,
        // thread/resume accepts developerInstructions yet does not apply it to an existing
        // thread. The persona given at thread/start lives in the thread's own history, and THAT
        // is what survives a resume / crash recovery (codex-persona.contract.test.ts pins both).
        // Consequence: a persona CHANGE only reaches a thread started fresh.
        ...(session.systemPrompt ? { developerInstructions: session.systemPrompt } : {}),
      });
      const threadId = res?.thread?.id ?? session.resumeId;
      if (this.endedWhileStarting(session, conn, threadId)) return;
      this.bindThread(session, threadId, res?.model);
      await this.backfill(session, conn, res?.thread?.turns).catch(() => { /* backfill is best-effort */ });
    } else {
      const res = await conn.request('thread/start', {
        cwd: session.cwd,
        model: session.model ?? null,
        approvalPolicy: session.approvalPolicy ?? this.approvalPolicy,
        sandbox: session.sandbox ?? this.sandbox,
        ...governedReviewer(session),
        ...threadConfigParam(session),
        // TOP-LEVEL, camelCase — NOT `settings.developer_instructions` (the OpenAI-documented
        // spelling is silently ignored by codex-cli; verified live on codex-cli 0.155.1).
        ...(session.systemPrompt ? { developerInstructions: session.systemPrompt } : {}),
      });
      const threadId = res?.thread?.id;
      if (typeof threadId !== 'string' || !threadId) throw new Error('thread/start returned no threadId');
      if (this.endedWhileStarting(session, conn, threadId)) return;
      this.bindThread(session, threadId, res?.model);
    }
  }

  /** A session killed while its thread/start|resume was in flight never got a threadId, so kill()
   *  had nothing to release. The app-server has loaded the thread (and its MCP set) regardless:
   *  release it now, unless another live session has since taken the thread over. */
  private endedWhileStarting(session: CodexSession, conn: JsonRpcStdioClient, threadId: string): boolean {
    if (this.sessions.get(session.terminalId) === session) return false;
    if (!this.ownerOf(threadId)) this.releaseThread(conn, threadId);
    return true;
  }

  /** Tell the shared app-server to let go of a thread. Without this it keeps the thread loaded
   *  and keeps its whole MCP tool set (~8 processes, ~0.8 GB) running until the daemon restarts.
   *  `thread/unsubscribe` drops our subscription; the app-server then unloads the thread and
   *  stops its MCP servers once it is idle for `thread_unload_delay_secs` (set in the app-server
   *  argv, see providers/codex.ts). The thread's history stays on disk, so a later
   *  `thread/resume` still works. Fire-and-forget: errors and a silent app-server never block
   *  or throw out of kill(). */
  private releaseThread(conn: JsonRpcStdioClient, threadId: string): void {
    if (!conn.alive) return;
    conn.request('thread/unsubscribe', { threadId }, this.releaseTimeoutMs)
      .catch(() => { /* best-effort: the thread is still unloaded when the daemon or app-server exits */ });
  }

  /** The terminal of the live session that owns `threadId` — bound to it, or resuming it. */
  private ownerOf(threadId: string): string | undefined {
    for (const s of this.sessions.values()) {
      if (s.threadId === threadId || s.resumeId === threadId) return s.terminalId;
    }
    return undefined;
  }

  private bindThread(session: CodexSession, threadId: string, model?: string): void {
    // Backstop for spawn()'s ownership check: never re-point a thread another live session owns.
    const owner = this.threadToTerminal.get(threadId);
    if (owner && owner !== session.terminalId && this.sessions.has(owner)) {
      throw new Error(`Codex thread ${threadId} is already open in another Dispatch thread`);
    }
    session.threadId = threadId;
    if (model) session.model = model;
    this.threadToTerminal.set(threadId, session.terminalId);
    if (!session.sessionId) {
      session.sessionId = threadId;
      this.fire('session', session.terminalId, threadId);
    }
    this.applyActions(session, session.translator.init(session.model));
  }

  /** Replay prior turns after a resume so the chat isn't blank (Codex has no Claude transcript
   *  to seed from). Best-effort: whole Claude events, emitted BEFORE any live stream_event so
   *  the reducer renders them in its non-streaming path. */
  private async backfill(session: CodexSession, conn: JsonRpcStdioClient, resumeTurns?: unknown): Promise<void> {
    if (!session.threadId) return;
    // The resume response already carries `turns`; only fall back to an explicit thread/read
    // when it didn't (per the Thread doc + spec mapping table).
    let turns = Array.isArray(resumeTurns) ? (resumeTurns as any[]) : [];
    if (turns.length === 0) {
      const res = await conn.request('thread/read', { threadId: session.threadId, includeTurns: true });
      turns = Array.isArray(res?.thread?.turns) ? res.thread.turns : [];
    }
    for (const turn of turns) {
      for (const item of Array.isArray(turn?.items) ? turn.items : []) {
        for (const ev of backfillItem(item)) this.pushEvent(session, ev);
      }
    }
  }

  private onConnExit(conn: JsonRpcStdioClient): void {
    if (this.conn !== conn) return; // a newer connection already replaced it
    this.conn = undefined;
    this.threadToTerminal.clear();
    const live = [...this.sessions.values()];
    if (live.length === 0 || !this.connSpec) return;
    // Crash recovery: respawn the shared server and thread/resume every live thread by id.
    const conn2 = this.makeConnection(this.connSpec);
    this.conn = conn2;
    for (const session of live) {
      session.recorder?.close(); // W3-D: a block that streamed when the app-server died is written
      session.pending = null;
      session.pendingApproval = null;
      this.fire('failed', session.terminalId);
      // A start/resume still in flight when the server died has no threadId yet; its resumeId
      // (a resumed thread) is the same native thread, so resume that rather than strand the session.
      const resumeId = session.threadId ?? session.resumeId;
      session.threadId = undefined;
      session.turnActive = false;
      // No id at all: a fresh thread/start was lost mid-flight, so start it fresh again.
      if (resumeId) session.resumeId = resumeId;
      session.ready = this.beginThread(session, conn2);
      // The thread now lives in a new OS process; tell the owner so the stored process number is not stale.
      this.fire('process-restarted', session.terminalId, conn2.pid);
    }
  }

  // --- inbound routing ---------------------------------------------------------------------

  private onNotification(method: string, params: any): void {
    const session = this.routeSession(method, params);
    if (!session) return;
    const eventTurnId = params?.turnId ?? params?.turn?.id;
    if (method !== 'turn/started' && eventTurnId && session.currentTurnId && eventTurnId !== session.currentTurnId) return;
    // Track turn liveness for interrupt/steer BEFORE translating (the translator only emits UI).
    if (method === 'turn/started') { session.turnActive = true; session.currentTurnId = params?.turn?.id;}
    else if (method === 'turn/completed') { session.turnActive = false; }
    this.applyActions(session, session.translator.translate({ method, params }));
  }

  private onServerRequest(method: string, id: RpcId, params: any): void {
    const session = this.routeSession(method, params);
    if (!session) { this.conn?.respondError(id, METHOD_NOT_FOUND, 'no session for request'); return; }
    const actions = session.translator.translate({ method, params, id });
    // A recognized approval yields exactly one approval action; anything else we can't answer.
    if (!actions.some((a) => a.kind === 'approval')) { this.conn?.respondError(id, METHOD_NOT_FOUND, 'unhandled server request'); return; }
    this.applyActions(session, actions);
  }

  /** Resolve the session a frame belongs to via its threadId (thread/started carries it as
   *  thread.id). Frames that predate the thread binding are dropped. */
  private routeSession(method: string, params: any): CodexSession | undefined {
    const threadId: string | undefined = method === 'thread/started' ? params?.thread?.id : params?.threadId;
    if (typeof threadId !== 'string') return undefined;
    const terminalId = this.threadToTerminal.get(threadId);
    return terminalId ? this.sessions.get(terminalId) : undefined;
  }

  /** Enact translator actions: buffer/emit events, and apply the permission membrane. */
  private applyActions(session: CodexSession, actions: TranslatedAction[]): void {
    for (const action of actions) {
      switch (action.kind) {
        case 'event':
          this.pushEvent(session, this.withDenyReason(session, action.event));
          break;
        case 'session':
          if (!session.sessionId) { session.sessionId = action.sessionId; this.fire('session', session.terminalId, action.sessionId); }
          break;
        case 'failed':
          session.turnActive = false;
          this.fire('failed', session.terminalId);
          break;
        case 'usage-limit':
          session.turnActive = false;
          this.fire('scheduled', session.terminalId, pauseLabel(action.limit.kind, action.limit.resetsAt, Date.now(), undefined, 30 * 60_000));
          this.fire('usage-limit', session.terminalId, action.limit);
          break;
        case 'busy':
          this.fire('busy', session.terminalId, { turnId: session.currentTurnId });
          break;
        case 'idle':
        case 'needs-help':
          // The Codex turn boundary: the shared declared-status chain (shared/settle-turn.ts), the
          // same one the Claude manager's `result` handler applies, minus its wake-scheduler branch
          // (Codex has no WAKE_TOOLS tracking). `action.summary` is the completed agentMessage text
          // the translator stashed (CodexTranslator.lastAgentText): it rides every 'idle' so a Codex
          // card keeps a REAL outcome line, where the Claude ring walk
          // (SessionService.lastAssistantTextPublic) finds nothing, or stale backfilled text.
          // No turn id is given, so every turn/completed settles, as before: an interrupt that
          // arrives after the turn ended gets a second turn/completed for the same turn, and the
          // thread must still settle on it (codex-manager.test.ts, "interrupt asks the server...").
          settleTurn(session, action, this.settleDeps);
          break;
        case 'approval':
          this.handleApproval(session, action);
          break;
      }
    }
  }

  /** The escalate/auto-allow membrane (identical policy to the Claude manager): consult the
   *  session's toolPolicy first (a deny answers the ServerRequest immediately — no pending, no
   *  human involvement, same as the Claude manager's can_use_tool deny path); otherwise surface
   *  a gated approval as a pending Need when supervised (or it's the always-surface
   *  AskUserQuestion analogue), else auto-approve it so an autonomous thread never blocks. */
  private handleApproval(session: CodexSession, action: Extract<TranslatedAction, { kind: 'approval' }>): void {
    // A governed (coordinator) thread must NEVER be allowed to grant itself expanded sandbox
    // permissions: `item/permissions/requestApproval` is Codex's own self-escalation surface —
    // the model asking to widen ITS OWN approval/sandbox — and `coordinatorToolPolicy` has no
    // opinion on the unmapped 'Permissions' tool name (adaptForPolicy passes it through
    // unchanged, and the policy's default branch is `allow: true`), so left to the policy below
    // this would auto-grant exactly what the model asked for. This check is therefore a
    // hardcoded deny whenever ANY toolPolicy is set — governed means never self-escalate,
    // independent of what the policy itself would say — decided before the policy consult and
    // before the escalate/auto-allow membrane ever sees it. No pending, no human involvement,
    // same in-turn-decline contract as a policy deny below.
    if (session.toolPolicy && action.method === 'item/permissions/requestApproval') {
      // Generic wording: this guard covers EVERY governed thread (coordinator or role run).
      this.declineWithReason(session, action, 'Dispatch policy: a governed thread cannot change its own sandbox or approval permissions — hand work that needs elevated access to an agent or a human.', { pairToolUse: true });
      return;
    }
    // AskUserQuestion's Codex analogue can't be auto-answered with a real decision — same
    // exemption the Claude manager gives AskUserQuestion — so it never runs through the policy.
    if (!action.alwaysSurface && session.toolPolicy) {
      const adapted = adaptForPolicy('codex', { toolName: action.pending.toolName, input: action.pending.input });
      const verdict = session.toolPolicy(adapted.toolName, adapted.input);
      if (!verdict.allow) {
        this.declineWithReason(session, action, verdict.message, { pairToolUse: false });
        return;
      }
    }
    if (session.escalate || action.alwaysSurface) {
      session.pending = action.pending;
      session.pendingApproval = { method: action.method, requestId: action.requestId };
      this.fire('permission', session.terminalId, action.pending);
    } else {
      this.conn?.respond(action.requestId, action.autoApprove);
    }
  }

  /**
   * Answer an approval with a policy decline, in-turn: no pending, no 'permission' emit, no human.
   * Codex's decline envelope carries no message field (see buildApprovalResponse), so Codex never
   * learns WHY — inject the reason as a synthetic tool_result paired to the tool_use by toolUseId,
   * so the coordinator/transcript sees it. Codex later completes the same item itself (status
   * 'declined', no output), and the chat pairs results LAST-wins, so the reason is remembered and
   * re-applied to that completion too (see applyActions). `pairToolUse` emits the tool_use first
   * for a request with no tool item of its own (a permissions escalation), so the result is never
   * an orphan row.
   */
  private declineWithReason(
    session: CodexSession,
    action: Extract<TranslatedAction, { kind: 'approval' }>,
    message: string,
    opts: { pairToolUse: boolean },
  ): void {
    this.conn?.respond(action.requestId, buildApprovalResponse(action.method, { behavior: 'deny', message }, action.pending));
    const toolUseId = action.pending.toolUseId;
    if (opts.pairToolUse) {
      this.pushEvent(session, {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: action.pending.toolName, input: action.pending.input }] },
      });
    }
    if (toolUseId) session.deniedReasons.set(toolUseId, message);
    this.pushEvent(session, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: message, is_error: true }] },
    });
  }

  /** Re-apply a remembered policy-deny reason to Codex's own later tool_result for the same
   *  tool (its declined completion has no output), so the reason is what the chat keeps. */
  private withDenyReason(session: CodexSession, event: unknown): unknown {
    const block = (event as any)?.type === 'user' ? (event as any).message?.content?.[0] : undefined;
    if (!block || block.type !== 'tool_result') return event;
    const reason = session.deniedReasons.get(block.tool_use_id);
    if (reason === undefined) return event;
    session.deniedReasons.delete(block.tool_use_id);
    return { ...(event as any), message: { ...(event as any).message, content: [{ ...block, content: reason, is_error: true }] } };
  }

  private pushEvent(session: CodexSession, event: unknown): void {
    session.ring.push(event);
    session.coalescer.observe(session.ring, event); // ring only: the live emit below is the event as it came
    this.fire('event', session.terminalId, event);
    // A signed-out or expired login (a 401, a refresh that failed): a typed event after the error.
    const auth = authRequiredFrame(event, 'codex', session.accountId);
    if (auth) {
      session.ring.push(auth);
      this.fire('event', session.terminalId, auth);
      this.fire('auth-required', session.terminalId, auth);
    }
  }

  // --- IStructuredManager surface ----------------------------------------------------------

  sendMessage(terminalId: string, content: string | ContentBlock[], source?: MessageSource): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    // Synthetic user echo (reproduce the Claude manager's behavior): the app-server does not
    // echo the user's turn as a renderable event, so buffer one so the bubble shows + replays.
    const echoContent: ContentBlock[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    const ev: any = { type: 'user', message: { role: 'user', content: echoContent } };
    if (source) ev.meta = { source };
    this.pushEvent(session, ev);
    this.fire('busy', terminalId);
    // Deliver once the thread is started (queued via the ready promise if still starting).
    session.ready = session.ready.then(() => this.startTurn(session, content)).catch((err) => {
      if (this.sessions.get(terminalId) !== session) return;
      this.pushEvent(session, { type: 'result', subtype: 'error', is_error: true, result: String(err) });
      this.fire('failed', terminalId);
    });
  }

  private async startTurn(session: CodexSession, content: string | ContentBlock[]): Promise<void> {
    if (!this.conn?.alive || !session.threadId) throw new Error('Codex thread is not connected');
    const input = toUserInput(content);
    if (session.turnActive && session.currentTurnId) {
      await this.conn.request('turn/steer', { threadId: session.threadId, expectedTurnId: session.currentTurnId, input });
    } else {
      // A pending model switch rides this turn: Codex applies `model` to "this turn and
      // subsequent turns" (TurnStartParams, codex-cli 0.167.0), so it is sent once.
      const model = session.nextTurnModel;
      const effort = session.pickedEffort;
      try {
        await this.conn.request('turn/start', { threadId: session.threadId, input, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      } catch (err) {
        if (model || effort) this.dropRefusedPick(session, model, effort, err);
        throw err;
      }
      if (session.nextTurnModel === model) { session.nextTurnModel = undefined; session.modelBeforePick = undefined; }
    }
  }

  /**
   * The app-server refused a turn/start that carried a changed model or effort. Drop the refused value so that no later
   * turn sends it again (it would fail every turn), put the model back, tell the thread, and tell the service so the saved
   * pick goes back too. The error names what it refused ("unsupported reasoning effort", "unknown model"); when it names
   * neither, both are dropped.
   */
  private dropRefusedPick(session: CodexSession, model: string | undefined, effort: string | undefined, err: unknown): void {
    // Only an ANSWER of "no" is a refusal. A dead app-server or a timeout says nothing about the picks, and a rejection that
    // reaches a session that is no longer the current one (a replacement took its place) must not touch the replacement.
    if (!(err instanceof CodexRpcError)) return;
    if (this.sessions.get(session.terminalId) !== session) return;
    const msg = err instanceof Error ? err.message : String(err);
    const effortHit = !!effort && /effort|reasoning/i.test(msg);
    const modelHit = !!model && /model/i.test(msg);
    const dropEffort = !!effort && (effortHit || !modelHit);
    const dropModel = !!model && (modelHit || !effortHit);
    if (!dropEffort && !dropModel) return;
    const info: { effort?: string; model?: string; restoredModel?: string } = {};
    if (dropEffort) { session.pickedEffort = undefined; info.effort = effort; }
    if (dropModel) {
      session.nextTurnModel = undefined;
      info.model = model;
      info.restoredModel = session.modelBeforePick;
      if (session.modelBeforePick) { session.model = session.modelBeforePick; session.translator.setModel(session.modelBeforePick); }
      session.modelBeforePick = undefined;
    }
    const what = [dropModel ? `model ${model}` : '', dropEffort ? `effort ${effort}` : ''].filter(Boolean).join(' and ');
    this.pushEvent(session, { type: 'system', subtype: 'settings_refused', message: `Codex refused the ${what}: ${msg}. It will not be sent again.` });
    // The chip shows the newest model frame, which beats the saved config: tell connected clients (and the replay) which model
    // the thread runs again. No `switched`, so no "Model switched" line.
    if (info.restoredModel) this.pushEvent(session, { type: 'system', subtype: 'model', model: info.restoredModel });
    this.fire('settings-refused', session.terminalId, info);
  }

  getModel(terminalId: string): string | undefined { return this.sessions.get(terminalId)?.model; }

  /**
   * Switch the thread's model for its next turn. The app-server has no standalone "set model"
   * request; `turn/start` takes `model` as an override for that turn and every later one, so the
   * pick is held and sent with the next turn (see startTurn). The conversation is kept.
   */
  async setModel(terminalId: string, model: string): Promise<string> {
    const session = this.sessions.get(terminalId);
    if (!session) throw new Error('This thread is not running');
    if (session.nextTurnModel === undefined) session.modelBeforePick = session.model;
    session.model = model;
    session.nextTurnModel = model;
    session.translator.setModel(model);
    this.pushEvent(session, { type: 'system', subtype: 'model', model, switched: true });
    return model;
  }

  /** Keep `effort` for the next turn: every `turn/start` carries it (the app-server has no standalone request). */
  async setEffort(terminalId: string, effort: string): Promise<void> {
    const session = this.sessions.get(terminalId);
    if (!session) throw new Error('This thread is not running');
    session.pickedEffort = effort;
  }

  postNotice(terminalId: string, message: string): void {
    const session = this.sessions.get(terminalId);
    if (session) this.pushEvent(session, { type: 'system', subtype: 'settings_refused', message });
  }

  /** The efforts each model takes, from the last `model/list` (see loadModelEfforts), or null if never asked. */
  modelEfforts(): Record<string, string[]> | null { return this.effortCache?.map ?? null; }
  /** The effort each model runs at by default, from the same `model/list`. */
  modelDefaultEfforts(): Record<string, string> | null { return this.effortCache?.defaults ?? null; }

  /**
   * Ask the running app-server which efforts each model takes (live-checked: they differ by model). Cached
   * for ten minutes. null when no app-server is running or it did not answer: the caller falls back to
   * the built-in table (codex-efforts.ts).
   */
  async loadModelEfforts(): Promise<Record<string, string[]> | null> {
    const c = this.effortCache;
    if (c && Date.now() - c.at < 10 * 60_000) return c.map;
    const conn = this.conn;
    if (!conn?.alive) return c?.map ?? null;
    try {
      // An app-server that is alive but never answers `initialize` would otherwise hold every caller (the
      // settings lock of a thread) for ever: give up after the same limit as model/list itself.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          conn.ready,
          new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('app-server not ready')), this.modelListTimeoutMs); timer.unref?.(); }),
        ]);
      } finally { clearTimeout(timer); }
      const map: Record<string, string[]> = {};
      const defaults: Record<string, string> = {};
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const res: any = await conn.request('model/list', { includeHidden: true, limit: 100, ...(cursor ? { cursor } : {}) }, this.modelListTimeoutMs);
        for (const m of res?.data ?? []) {
          const efforts = (m?.supportedReasoningEfforts ?? []).map((e: any) => e?.reasoningEffort).filter((e: unknown): e is string => typeof e === 'string' && !!e);
          if (typeof m?.model === 'string' && efforts.length) {
            map[m.model] = efforts;
            if (typeof m?.defaultReasoningEffort === 'string' && efforts.includes(m.defaultReasoningEffort)) defaults[m.model] = m.defaultReasoningEffort;
          }
        }
        cursor = typeof res?.nextCursor === 'string' && res.nextCursor ? res.nextCursor : null;
        if (!cursor) break;
      }
      if (Object.keys(map).length) this.effortCache = { at: Date.now(), map, defaults };
      return this.effortCache?.map ?? null;
    } catch {
      return c?.map ?? null;
    }
  }

  answerPermission(terminalId: string, requestId: string, decision: PermissionDecision): boolean {
    const session = this.sessions.get(terminalId);
    if (!session || !session.pending || !session.pendingApproval) return false;
    if (requestId && session.pending.requestId !== requestId) return false;
    const response = buildApprovalResponse(session.pendingApproval.method, decision, session.pending);
    this.conn?.respond(session.pendingApproval.requestId, response);
    session.pending = null;
    session.pendingApproval = null;
    this.fire('resolved', terminalId);
    return true;
  }

  setEscalate(terminalId: string, escalate: boolean): boolean {
    const session = this.sessions.get(terminalId);
    if (!session) return false;
    session.escalate = escalate;
    // Going autonomous with a PLAIN gated approval pending (not an AskUserQuestion) → auto-allow
    // it immediately so a supervised thread unblocks the moment the user flips the dial.
    if (!escalate && session.pending && session.pendingApproval && session.pendingApproval.method !== 'item/tool/requestUserInput') {
      const response = buildApprovalResponse(session.pendingApproval.method, { behavior: 'allow' }, session.pending);
      this.conn?.respond(session.pendingApproval.requestId, response);
      session.pending = null;
      session.pendingApproval = null;
      this.fire('resolved', terminalId);
    }
    return true;
  }

  interrupt(terminalId: string): boolean {
    const session = this.sessions.get(terminalId);
    if (!session || !this.conn?.alive || !session.threadId || !session.currentTurnId) return false;
    void this.conn.request('turn/interrupt', { threadId: session.threadId, turnId: session.currentTurnId }).catch(() => {});
    return true;
  }

  compact(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session || !this.conn?.alive || !session.threadId) return;
    void this.conn.request('thread/compact/start', { threadId: session.threadId }).catch(() => {});
  }

  /**
   * Record what the agent says about this turn. Stored, not applied — mirrors the Claude
   * manager's noteDeclaredStatus (see manager.ts's Session.declared) so both transports
   * satisfy IStructuredManager identically.
   */
  noteDeclaredStatus(terminalId: string, decl: StatusDeclaration): void {
    const session = this.sessions.get(terminalId);
    if (session) session.declared = decl;
  }

  getPending(terminalId: string): PendingPermission | null { return this.sessions.get(terminalId)?.pending ?? null; }
  getSessionId(terminalId: string): string | undefined { return this.sessions.get(terminalId)?.sessionId; }

  lastFrameAt(terminalId: string): number | undefined { return this.sessions.get(terminalId)?.ring.lastPushAt; }
  getEvents(terminalId: string): unknown[] { return this.sessions.get(terminalId)?.ring.snapshot() ?? []; }
  /** The last ended turn's own texts (IStructuredManager.getTurnTexts): the completed agentMessage items, not the ring's deltas. */
  getTurnTexts(terminalId: string): string[] | null { return this.sessions.get(terminalId)?.translator.lastTurnTexts() ?? null; }
  getEventsTail(terminalId: string, n: number): unknown[] { return this.sessions.get(terminalId)?.ring.tail(n) ?? []; }
  isAlive(terminalId: string): boolean { return this.sessions.has(terminalId); }

  kill(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    session.pending = null;
    if (session.threadId) this.threadToTerminal.delete(session.threadId);
    this.sessions.delete(terminalId);
    session.recorder?.close(); // W3-D: a block that streams at a stop (of the thread, of the daemon) is written
    this.fire('exit', terminalId, 0);
    // Tear down the shared server once the last codex thread is gone (closing it ends every
    // thread's MCP set); otherwise release just this thread so its MCP set does not outlive it.
    if (this.sessions.size === 0 && this.conn) { this.conn.close(); this.conn = undefined; }
    else if (session.threadId && this.conn) this.releaseThread(this.conn, session.threadId);
  }

  killAll(): void { for (const id of [...this.sessions.keys()]) this.kill(id); }
}

/**
 * A governed thread (any toolPolicy — a coordinator or a role run) pins Codex's approval reviewer
 * to `user`, i.e. the client: Dispatch. Otherwise `approvals_reviewer = "auto_review"` (or
 * `"guardian_subagent"`) in the user's config.toml would let Codex answer a sandbox escape with its
 * OWN reviewer, and the request would never reach handleApproval — the membrane would be skipped.
 * An ungoverned thread keeps whatever the user's Codex config says. Live-verified on codex-cli
 * 0.156.1: thread/start accepts `approvalsReviewer: 'user'` and echoes it back.
 */
function governedReviewer(session: CodexSession): { approvalsReviewer?: 'user' } {
  return session.toolPolicy ? { approvalsReviewer: 'user' } : {};
}

/** The thread's own `config` overrides (its MCP identity), or nothing when it has none. */
function threadConfigParam(session: CodexSession): { config?: Record<string, unknown> } {
  return session.threadConfig && Object.keys(session.threadConfig).length ? { config: session.threadConfig } : {};
}

/** Map a Claude turn payload (string or content blocks) to Codex UserInput[]. */
function toUserInput(content: string | ContentBlock[]): unknown[] {
  if (typeof content === 'string') return [{ type: 'text', text: content, text_elements: [] }];
  const out: unknown[] = [];
  for (const b of content) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text, text_elements: [] });
    else if (b.type === 'image') {
      const src: any = b.source;
      if (src?.type === 'base64' && src.data) out.push({ type: 'image', url: `data:${src.media_type};base64,${src.data}` });
      else if (src?.type === 'url' && src.url) out.push({ type: 'image', url: src.url });
    }
  }
  return out.length ? out : [{ type: 'text', text: '', text_elements: [] }];
}

/** Turn a completed Codex ThreadItem from thread/read history into whole Claude events for the
 *  resume backfill. Emitted before any live stream_event so the reducer renders them plainly. */
function backfillItem(item: any): unknown[] {
  switch (item?.type) {
    case 'userMessage': {
      const text = (Array.isArray(item.content) ? item.content : []).filter((c: any) => c?.type === 'text').map((c: any) => c.text ?? '').join('');
      return text ? [{ type: 'user', message: { role: 'user', content: text } }] : [];
    }
    case 'agentMessage':
      return item.text ? [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: item.text }] } }] : [];
    case 'reasoning': {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].join('\n').trim();
      return text ? [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] } }] : [];
    }
    case 'commandExecution':
    case 'fileChange':
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const name = item.type === 'commandExecution' ? 'Shell' : item.type === 'fileChange' ? 'ApplyPatch' : String(item.tool ?? item.type);
      const input = item.type === 'commandExecution' ? { command: item.command } : item.type === 'fileChange' ? { changes: item.changes } : { arguments: item.arguments };
      const output = item.type === 'commandExecution' ? (item.aggregatedOutput ?? '') : '';
      return [
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: item.id, name, input }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: item.id, content: output, is_error: false }] } },
      ];
    }
    default:
      return [];
  }
}
