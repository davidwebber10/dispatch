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
import { CodexTranslator, buildApprovalResponse, type ApprovalMethod, type TranslatedAction } from './codex-translate.js';
import { adaptForPolicy } from '../overseer/policy-adapter.js';

const MAX_EVENTS = 5000;

/** A JSON-RPC message id (client requests use our counter; server requests use the server's). */
type RpcId = string | number;

/**
 * The single shared newline-delimited JSON-RPC channel to a `codex app-server` child. Handles
 * the `initialize` handshake, request/response correlation, and fans inbound server→client
 * requests + notifications out to the manager. Knows nothing about Codex payload shapes.
 */
class CodexConnection extends EventEmitter {
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
      for (const { reject } of this.pending.values()) reject(new Error('app-server exited'));
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
        clientInfo: { name: 'dispatch', title: 'Dispatch', version: '2.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.notify('initialized', undefined);
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
    // A response to one of OUR requests: has id + result|error, no method.
    if (msg.id !== undefined && msg.method === undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error?.message || 'rpc error'));
      else p.resolve(msg.result);
      return;
    }
    // A server→client request: has id + method (must be answered).
    if (msg.id !== undefined && typeof msg.method === 'string') {
      this.emit('server-request', msg.method, msg.id, msg.params ?? {});
      return;
    }
    // A notification: method only.
    if (typeof msg.method === 'string') this.emit('notification', msg.method, msg.params ?? {});
  }

  request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error('app-server not connected'));
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

  /** Reject a server→client request we don't handle, so it doesn't leak. */
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

interface CodexSession {
  terminalId: string;
  translator: CodexTranslator;
  events: unknown[];
  escalate: boolean;
  pending: PendingPermission | null;
  /** The Codex ServerRequest a surfaced `pending` corresponds to (method + server req id). */
  pendingApproval: { method: ApprovalMethod; requestId: RpcId } | null;
  threadId?: string;
  currentTurnId?: string;
  turnActive: boolean;
  sessionId?: string;
  model?: string;
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
  /** True when this thread must have the shared app-server to itself (see
   *  StructuredSpawnOpts.exclusiveConnection) — while it is live, every other spawn is refused. */
  exclusive: boolean;
  /** toolUseId → the policy reason a governed thread's approval was declined with, until Codex's
   *  own completion of that item arrives (see declineWithReason / withDenyReason). */
  deniedReasons: Map<string, string>;
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
}

export class CodexStructuredSessionManager extends EventEmitter implements IStructuredManager {
  private sessions = new Map<string, CodexSession>();
  private threadToTerminal = new Map<string, string>();
  private conn?: CodexConnection;
  private connSpec?: { command: string; args: string[]; cwd: string; env: Record<string, string> };
  private defaultEnv: Record<string, string> = {};
  private readonly approvalPolicy: 'untrusted' | 'on-request' | 'never';
  private readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';

  constructor(opts: CodexManagerOptions = {}) {
    super();
    this.setMaxListeners(0);
    this.approvalPolicy = opts.approvalPolicy ?? 'on-request';
    this.sandbox = opts.sandbox ?? 'workspace-write';
  }

  setDefaultEnv(env: Record<string, string>): void { this.defaultEnv = env; }

  spawn(terminalId: string, opts: StructuredSpawnOpts): number {
    // M3 block: the shared app-server's argv/env carry the FIRST spawner's `dispatch` MCP identity,
    // so a thread that must keep its own identity (a coordinator) may not share it — refuse BEFORE
    // touching any state, in both directions. A thread re-spawning ITSELF is not "another" thread.
    const others = [...this.sessions.values()].filter((s) => s.terminalId !== terminalId);
    if (opts.exclusiveConnection && others.length > 0) {
      throw new Error(
        'A Codex coordinator needs the Codex app-server to itself (Codex threads share one MCP identity — M3, not yet fixed). ' +
        'Stop the other Codex Pretty threads first, or run this coordinator on Claude.',
      );
    }
    if (others.some((s) => s.exclusive)) {
      throw new Error(
        'A Codex coordinator is running, and Codex Pretty threads cannot share its app-server yet (one shared MCP identity — M3, not yet fixed). ' +
        'Use another harness (or Codex CLI transport) for this thread.',
      );
    }
    if (this.sessions.has(terminalId)) this.kill(terminalId);
    // An exclusive spawn never inherits a connection some earlier spawn created (kill() above
    // closes it once the last thread is gone; this also covers a connection left with no threads).
    if (opts.exclusiveConnection && this.conn) { this.conn.close(); this.conn = undefined; }
    const conn = this.ensureConnection(opts);
    const session: CodexSession = {
      terminalId,
      translator: new CodexTranslator(),
      events: [],
      escalate: opts.escalate ?? false,
      pending: null,
      pendingApproval: null,
      turnActive: false,
      cwd: opts.workDir,
      model: opts.model,
      resumeId: opts.resumeId,
      systemPrompt: opts.systemPrompt,
      toolPolicy: opts.toolPolicy,
      approvalPolicy: opts.approvalPolicy,
      sandbox: opts.sandbox,
      exclusive: opts.exclusiveConnection === true,
      deniedReasons: new Map(),
      ready: Promise.resolve(),
    };
    if (opts.seedEvents?.length) {
      session.events.push(...opts.seedEvents);
      if (session.events.length > MAX_EVENTS) session.events.splice(0, session.events.length - MAX_EVENTS);
    }
    this.sessions.set(terminalId, session);
    session.ready = this.startThread(session, conn).catch((err) => {
      this.pushEvent(session, { type: 'system', subtype: 'spawn_error', message: String(err) });
      this.emit('failed', session.terminalId);
    });
    return conn.pid;
  }

  /** Lazily create the ONE shared app-server connection (first spawn wins its command/env). */
  private ensureConnection(opts: StructuredSpawnOpts): CodexConnection {
    if (this.conn?.alive) return this.conn;
    const env = { ...process.env, ...this.defaultEnv, ...opts.env } as Record<string, string>;
    this.connSpec = { command: opts.command, args: opts.args, cwd: opts.workDir, env };
    this.conn = this.makeConnection(this.connSpec);
    return this.conn;
  }

  private makeConnection(spec: { command: string; args: string[]; cwd: string; env: Record<string, string> }): CodexConnection {
    const conn = new CodexConnection(spec.command, spec.args, spec.cwd, spec.env);
    conn.on('notification', (method: string, params: any) => { if (this.conn === conn) this.onNotification(method, params); });
    conn.on('server-request', (method: string, id: RpcId, params: any) => this.onServerRequest(method, id, params));
    conn.on('exit', () => this.onConnExit(conn));
    return conn;
  }

  /** Start (or resume) the thread for a session, then bind its threadId for routing. */
  private async startThread(session: CodexSession, conn: CodexConnection): Promise<void> {
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
        // Resent for completeness, but NOT load-bearing: live-verified on codex-cli 0.156.1,
        // thread/resume accepts developerInstructions yet does not apply it to an existing
        // thread. The persona given at thread/start lives in the thread's own history, and THAT
        // is what survives a resume / crash recovery (codex-persona.contract.test.ts pins both).
        // Consequence: a persona CHANGE only reaches a thread started fresh.
        ...(session.systemPrompt ? { developerInstructions: session.systemPrompt } : {}),
      });
      this.bindThread(session, res?.thread?.id ?? session.resumeId, res?.model);
      await this.backfill(session, conn, res?.thread?.turns).catch(() => { /* backfill is best-effort */ });
    } else {
      const res = await conn.request('thread/start', {
        cwd: session.cwd,
        model: session.model ?? null,
        approvalPolicy: session.approvalPolicy ?? this.approvalPolicy,
        sandbox: session.sandbox ?? this.sandbox,
        ...governedReviewer(session),
        // TOP-LEVEL, camelCase — NOT `settings.developer_instructions` (the OpenAI-documented
        // spelling is silently ignored by codex-cli; verified live on codex-cli 0.155.1).
        ...(session.systemPrompt ? { developerInstructions: session.systemPrompt } : {}),
      });
      const threadId = res?.thread?.id;
      if (typeof threadId !== 'string' || !threadId) throw new Error('thread/start returned no threadId');
      this.bindThread(session, threadId, res?.model);
    }
  }

  private bindThread(session: CodexSession, threadId: string, model?: string): void {
    session.threadId = threadId;
    if (model) session.model = model;
    this.threadToTerminal.set(threadId, session.terminalId);
    if (!session.sessionId) {
      session.sessionId = threadId;
      this.emit('session', session.terminalId, threadId);
    }
    this.applyActions(session, session.translator.init(session.model));
  }

  /** Replay prior turns after a resume so the chat isn't blank (Codex has no Claude transcript
   *  to seed from). Best-effort: whole Claude events, emitted BEFORE any live stream_event so
   *  the reducer renders them in its non-streaming path. */
  private async backfill(session: CodexSession, conn: CodexConnection, resumeTurns?: unknown): Promise<void> {
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

  private onConnExit(conn: CodexConnection): void {
    if (this.conn !== conn) return; // a newer connection already replaced it
    this.conn = undefined;
    this.threadToTerminal.clear();
    const live = [...this.sessions.values()];
    if (live.length === 0 || !this.connSpec) return;
    // Crash recovery: respawn the shared server and thread/resume every live thread by id.
    const conn2 = this.makeConnection(this.connSpec);
    this.conn = conn2;
    for (const session of live) {
      session.pending = null;
      session.pendingApproval = null;
      this.emit('failed', session.terminalId);
      const resumeId = session.threadId;
      session.threadId = undefined;
      session.turnActive = false;
      if (!resumeId) continue;
      session.resumeId = resumeId;
      session.ready = this.startThread(session, conn2).catch((err) => {
        this.pushEvent(session, { type: 'system', subtype: 'spawn_error', message: String(err) });
        this.emit('failed', session.terminalId);
      });
    }
  }

  // --- inbound routing ---------------------------------------------------------------------

  private onNotification(method: string, params: any): void {
    const session = this.routeSession(method, params);
    if (!session) return;
    const eventTurnId = params?.turnId ?? params?.turn?.id;
    if (method !== 'turn/started' && eventTurnId && session.currentTurnId && eventTurnId !== session.currentTurnId) return;
    // Track turn liveness for interrupt/steer BEFORE translating (the translator only emits UI).
    if (method === 'turn/started') { session.turnActive = true; session.currentTurnId = params?.turn?.id; }
    else if (method === 'turn/completed') { session.turnActive = false; }
    this.applyActions(session, session.translator.translate({ method, params }));
  }

  private onServerRequest(method: string, id: RpcId, params: any): void {
    const session = this.routeSession(method, params);
    if (!session) { this.conn?.respondError(id, 'no session for request'); return; }
    const actions = session.translator.translate({ method, params, id });
    // A recognized approval yields exactly one approval action; anything else we can't answer.
    if (!actions.some((a) => a.kind === 'approval')) { this.conn?.respondError(id, 'unhandled server request'); return; }
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
          if (!session.sessionId) { session.sessionId = action.sessionId; this.emit('session', session.terminalId, action.sessionId); }
          break;
        case 'failed':
          session.turnActive = false;
          this.emit('failed', session.terminalId);
          break;
        case 'busy':
          this.emit('busy', session.terminalId, { turnId: session.currentTurnId });
          break;
        case 'idle':
        case 'needs-help':
          this.settleTurn(session, action);
          break;
        case 'approval':
          this.handleApproval(session, action);
          break;
      }
    }
  }

  /**
   * The Codex turn boundary. Applies the SAME declared-status precedence chain the Claude
   * manager's `result` handler establishes (see manager.ts), minus the wake-scheduler branch —
   * Codex has no WAKE_TOOLS/lastToolUse tracking at all, so that branch simply doesn't exist
   * here:
   *   1. declared `needs_you`      → 'needs-help', inferred: false
   *   2. any OTHER declaration     → 'idle', declared: true, state: 'done' | 'blocked' (a declared
   *      `blocked` still settles idle, same as Claude — a thread waiting on another agent isn't a
   *      needs-help state — but `state` carries WHICH one was declared, and `blocker` the blocker
   *      text when 'blocked' supplied one, so noteTurnOutcome can persist the distinction instead
   *      of losing it at this event boundary; see manager.ts's IStructuredManager doc comment)
   *   3. no declaration + the translator's own text-heuristic fired → 'needs-help', inferred: true
   *   4. otherwise                 → 'idle', declared: false
   * `action.summary` is the actual completed agentMessage text stashed by the translator
   * (CodexTranslator.lastAgentText) — carried through regardless of branch so a Codex card
   * persists a REAL outcome line instead of the Claude-ring walk (SessionService.lastAssistantTextPublic),
   * which on Codex returns either nothing or stale text backfilled from a prior resume (see the
   * translator's doc comment on `lastAgentText` for why).
   */
  private settleTurn(session: CodexSession, action: Extract<TranslatedAction, { kind: 'idle' | 'needs-help' }>): void {
    const declared = session.declared;
    session.declared = undefined; // a declaration is per-turn — must not leak into the next one
    const summary = action.summary;
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
      this.emit('permission', session.terminalId, action.pending);
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
    session.events.push(event);
    if (session.events.length > MAX_EVENTS) session.events.shift();
    this.emit('event', session.terminalId, event);
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
    this.emit('busy', terminalId);
    // Deliver once the thread is started (queued via the ready promise if still starting).
    session.ready = session.ready.then(() => this.startTurn(session, content)).catch((err) => {
      if (this.sessions.get(terminalId) !== session) return;
      this.pushEvent(session, { type: 'result', subtype: 'error', is_error: true, result: String(err) });
      this.emit('failed', terminalId);
    });
  }

  private async startTurn(session: CodexSession, content: string | ContentBlock[]): Promise<void> {
    if (!this.conn?.alive || !session.threadId) throw new Error('Codex thread is not connected');
    const input = toUserInput(content);
    if (session.turnActive && session.currentTurnId) {
      await this.conn.request('turn/steer', { threadId: session.threadId, expectedTurnId: session.currentTurnId, input });
    } else {
      await this.conn.request('turn/start', { threadId: session.threadId, input });
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
    this.emit('resolved', terminalId);
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
      this.emit('resolved', terminalId);
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
    if (session.threadId) this.threadToTerminal.delete(session.threadId);
    this.sessions.delete(terminalId);
    this.emit('exit', terminalId, 0);
    // Tear down the shared server once the last codex thread is gone.
    if (this.sessions.size === 0 && this.conn) { this.conn.close(); this.conn = undefined; }
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
