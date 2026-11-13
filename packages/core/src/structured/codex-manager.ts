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
import { childEnv } from '../platform/inherited-env.js';
import { randomUUID } from 'node:crypto';
import { blockedEvent, blockedResolvedEvent, approvalTitle, type BlockedAction, type Approvals } from '../os/approvals.js';
import { EventRing } from './shared/event-ring.js';
import type { JournalRecorder, ThreadRecorder } from '../journal/recorder.js';
import { BlockDeltaCoalescer } from './shared/stream-compaction.js';
import { JsonRpcStdioClient, METHOD_NOT_FOUND, type RpcId } from './shared/jsonrpc-client.js';
import { settleTurn, type SettleDeps } from './shared/settle-turn.js';
import { StructuredEmitter } from './shared/events.js';
import { logThreadModel } from './model-log.js';
import { codexServiceTier, CODEX_STANDARD_TIER } from './codex-fast.js';
import { isHostedBox } from '../os/hosted-mode.js';
import { SENT_MARK, isHarnessContext, CONTEXT_NOTICE } from '../conversation/task-notification.js';
import { boxLog } from '../os/box-log.js';
import { SubagentTracker, titleFromAgentPath, subagentResultText, RUNNING_STATES, type SubagentInfo, type SubagentState, type StopAgentResult } from './shared/subagents.js';

/**
 * The default sandbox for Codex threads on a hosted box (owner decision, 2026-11-13).
 *
 * Codex 0.167's own sandbox needs bubblewrap, which needs user namespaces. Privilege separation
 * blocks user namespaces on purpose, so every Codex shell call failed ("bwrap: No permissions to
 * create a new namespace"). On a hosted box the box itself is the sandbox: workloads run as
 * uid 1000 with no_new_privs and a reduced capability set, cannot read daemon state, and reach
 * the network only through the egress control. So hosted Codex threads run with Codex's inner
 * sandbox off. Approval policy `never` stays forbidden (codex-requirements.toml).
 *
 * `DISPATCH_CODEX_SANDBOX=codex` keeps Codex's own sandbox (for a host where namespaces work).
 * Returns undefined off a hosted box, so local installs keep their default.
 */
export function hostedSandbox(env: NodeJS.ProcessEnv = process.env): 'danger-full-access' | undefined {
  if (!isHostedBox(env)) return undefined;
  if ((env.DISPATCH_CODEX_SANDBOX ?? '').trim().toLowerCase() === 'codex') return undefined;
  return 'danger-full-access';
}

/** A refusal said in plain words for the person: shown as its message alone, with no "Error:" in front. */
class PlainRefusal extends Error {}
const shown = (err: unknown): string => (err instanceof PlainRefusal ? err.message : String(err));

/**
 * A refusal ANSWER we cannot read further, for the person: "Codex refused this request: <short detail>".
 * Only a refusal Codex labels (a turn error with codexErrorInfo `modelNotFound`, codex-translate.ts) becomes
 * "This account cannot use <model>"; an RPC error text is never guessed into that sentence.
 */
function refusedRequest(err: unknown): PlainRefusal {
  const detail = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim().slice(0, 200);
  return new PlainRefusal(`Codex refused this request: ${detail}`);
}

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

/**
 * A Codex sub-thread (a subagent the main agent, or another subagent, spawned). It is not a Dispatch
 * thread: its frames are routed to the session of the thread that owns its root, translated with its
 * own translator, and tagged `parent_tool_use_id: <sub-thread id>` (see shared/subagents.ts).
 */
interface SubThread {
  id: string;
  terminalId: string;
  /** The sub-thread that spawned it, or null for the main agent. */
  parentId: string | null;
  translator: CodexTranslator;
  currentTurnId?: string;
  turnActive: boolean;
  /** The person stopped this subagent: any turn it starts is interrupted, and it is never revived. */
  stopRequested?: boolean;
  /** The final text of its last turn (an end reported by an item before that turn's own end needs it). */
  lastResult?: string;
  /** A `completed` item came before the sub-thread's own turn end: the end waits for it, at most FINISH_WAIT_MS. */
  finishTimer?: ReturnType<typeof setTimeout>;
}

/** How long a reported end waits for the sub-thread's own turn end (which carries the final text). */
const FINISH_WAIT_MS = 10_000;

/** A surfaced (or waiting) approval: the pending the person sees and the ServerRequest it answers. */
interface QueuedApproval {
  pending: PendingPermission;
  approval: { method: ApprovalMethod; requestId: RpcId };
}

interface CodexSession {
  /** The app-server refused the service tier once: this session asks for none again (codex-fast.ts). */
  tierRefused?: boolean;
  /** The service tier the app-server reported at start or resume (undefined: none reported, standard speed). */
  serviceTier?: string;
  /** The service tier the last start or resume asked for. */
  serviceTierAsked?: string;
  /** The subagents of this thread (Codex sub-threads), see shared/subagents.ts. */
  subagents: SubagentTracker;
  /** Approvals that came while another one waited for the person; surfaced one at a time. */
  approvalQueue: QueuedApproval[];
  /** Results of subagents that ended while the main turn ran: delivered in one main turn when it ends. */
  agentResults: Array<{ id: string; title: string; state: SubagentState; text: string }>;
  /** A delivery turn was asked for and its turn/started has not come yet: a second delivery waits. */
  delivering?: boolean;
  /** Turns the daemon started by itself since the person's last message (capped: autoTurnLimit). */
  autoTurns: number;
  /** The cap's notice was posted for the current run of automatic turns. */
  capNoticed?: boolean;
  /** The person stopped the reply (interrupt, stop-all): no delivery until their next message. */
  deliveryPaused?: boolean;
  /** How the last main turn ended: only after a normal end may a delivery follow. */
  lastMainEnd?: 'normal' | 'other';
  /** Smart approvals (os/approvals.ts): on-request + workspace-write + the auto_review reviewer. */
  smart?: boolean;
  /** Reviewer denials nobody answered yet (the in-thread cards), with the raw notification for approveGuardianDeniedAction
   *  and the thread (main or sub-thread) whose action was denied. */
  blocked?: Array<{ block: BlockedAction; raw: any; threadId?: string }>;
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
  /** Sub-thread id → its routing record (see SubThread). */
  private subThreads = new Map<string, SubThread>();
  /** Sub-threads of threads that were stopped: never bound again while this app-server runs. */
  private deadSubThreads = new Set<string>();
  /** The most turns the daemon starts by itself (subagent results) since the person's last message. */
  autoTurnLimit = 3;
  /** The time limit of a held idle with no subagent frame (shared/subagents.ts; a test shortens it). */
  subagentLostAfterMs = 30 * 60_000;
  private conn?: JsonRpcStdioClient;
  private connSpec?: { command: string; args: string[]; cwd: string; env: Record<string, string> };
  private defaultEnv: Record<string, string> = {};
  private readonly approvalPolicy: 'untrusted' | 'on-request' | 'never';
  private readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  private readonly releaseTimeoutMs: number;
  private readonly modelListTimeoutMs: number;
  private effortCache?: { at: number; map: Record<string, string[]>; defaults: Record<string, string>; tiers?: Record<string, string[]> };
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
    this.sandbox = opts.sandbox ?? hostedSandbox() ?? 'workspace-write';
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
      subagents: undefined as unknown as SubagentTracker,
      approvalQueue: [],
      agentResults: [],
      autoTurns: 0,
      terminalId,
      accountId: opts.accountId,
      translator: new CodexTranslator(),
      ring: new EventRing(),
      coalescer: new BlockDeltaCoalescer(),
      // Smart: a request that reaches Dispatch is one the reviewer handed to the person (high risk): surface it.
      escalate: (opts.escalate ?? false) || opts.approvals === 'smart',
      smart: opts.approvals === 'smart' && !opts.toolPolicy,
      blocked: [],
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
    session.subagents = new SubagentTracker('codex', { emit: (frame) => this.pushEvent(session, frame), lostAfterMs: this.subagentLostAfterMs });
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
    const env = childEnv(this.defaultEnv, opts.env);
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
      this.pushEvent(session, { type: 'system', subtype: 'spawn_error', message: shown(err) });
      this.fire('failed', session.terminalId);
    });
  }

  /** Start (or resume) the thread for a session, then bind its threadId for routing. */
  private async startThread(session: CodexSession, conn: JsonRpcStdioClient): Promise<void> {
    await conn.ready;
    if (session.resumeId) {
      const res = await this.withTier(session, true, (tier) => conn.request('thread/resume', {
        threadId: session.resumeId,
        cwd: session.cwd,
        model: session.model ?? null,
        ...(tier ? { serviceTier: tier } : {}),
        // Carry a governed thread's per-spawn override through crash recovery too — otherwise a
        // coordinator resumed after the shared app-server child restarts would silently fall
        // back to the manager-wide default (see CodexSession.approvalPolicy/sandbox doc comment).
        ...approvalParams(session, this.approvalPolicy, this.sandbox),
        ...threadConfigParam(session),
        // Resent for completeness, but NOT load-bearing: live-verified on codex-cli 0.156.1,
        // thread/resume accepts developerInstructions yet does not apply it to an existing
        // thread. The persona given at thread/start lives in the thread's own history, and THAT
        // is what survives a resume / crash recovery (codex-persona.contract.test.ts pins both).
        // Consequence: a persona CHANGE only reaches a thread started fresh.
        ...(session.systemPrompt ? { developerInstructions: session.systemPrompt } : {}),
      }));
      const threadId = res?.thread?.id ?? session.resumeId;
      if (this.endedWhileStarting(session, conn, threadId)) return;
      this.bindThread(session, threadId, res?.model);
      await this.backfill(session, conn, res?.thread?.turns).catch(() => { /* backfill is best-effort */ });
    } else {
      const res = await this.withTier(session, false, (tier) => conn.request('thread/start', {
        cwd: session.cwd,
        model: session.model ?? null,
        ...(tier ? { serviceTier: tier } : {}),
        ...approvalParams(session, this.approvalPolicy, this.sandbox),
        ...threadConfigParam(session),
        // TOP-LEVEL, camelCase — NOT `settings.developer_instructions` (the OpenAI-documented
        // spelling is silently ignored by codex-cli; verified live on codex-cli 0.155.1).
        ...(session.systemPrompt ? { developerInstructions: session.systemPrompt } : {}),
      })).catch((err) => {
        // A refusal answer fails the start in plain words (spawn_error), never on another model.
        if (err instanceof CodexRpcError) throw refusedRequest(err);
        throw err;
      });
      const threadId = res?.thread?.id;
      if (typeof threadId !== 'string' || !threadId) throw new Error('thread/start returned no threadId');
      if (this.endedWhileStarting(session, conn, threadId)) return;
      this.bindThread(session, threadId, res?.model);
    }
  }

  /**
   * Run a thread/start or thread/resume with the session's service tier (codex-fast.ts), and record the tier
   * the app-server REPORTS (its answer's `serviceTier`), not the one asked for.
   *  - A resumed thread keeps the tier saved with it when the field is left out (verified on codex-cli
   *    0.167.2: omitted kept `priority`; `default` answered `default`). So on a hosted box a resume that
   *    asks for no tier (switched off, or refused before) asks for `default` explicitly.
   *  - A refusal answer to a request that carried a tier: the same request once more without it; the thread
   *    runs at standard speed rather than not at all. An answer with another tier (Codex drops a tier it
   *    does not offer, it does not refuse it) also marks the tier refused for this session.
   * Both log `thread.fast.refused`. Any other error is the caller's.
   */
  private async withTier<T>(session: CodexSession, resume: boolean, call: (tier: string | undefined) => Promise<T>): Promise<T> {
    // The tiers each model offers depend on the signed-in account (model/list): read them before the first
    // start on a hosted box, so a tier the account does not offer is never asked for.
    if (isHostedBox() && !this.effortCache) await this.loadModelEfforts().catch(() => null);
    const asked = this.serviceTierFor(session);
    const standard = resume && isHostedBox() ? CODEX_STANDARD_TIER : undefined;
    const send = asked ?? standard;
    session.serviceTierAsked = send;
    let res: T;
    try {
      res = await call(send);
    } catch (err) {
      if (!send || !(err instanceof CodexRpcError)) throw err;
      if (asked) {
        // The fast tier was refused: once more at the standard tier (on a resume) or with no tier field.
        session.tierRefused = true;
        session.serviceTierAsked = standard;
        boxLog('thread.fast.refused', { thread: session.terminalId, tier: asked, reason: err.message }, 'warn');
        try {
          res = await call(standard);
        } catch (again) {
          if (!standard || !(again instanceof CodexRpcError)) throw again;
          session.serviceTierAsked = undefined;
          res = await call(undefined);
        }
      } else {
        // Only the standard tier was asked for (a resume with the switch off) and it was refused: once more with
        // no tier field, so the kill switch never stops a thread from starting (review N5).
        session.serviceTierAsked = undefined;
        boxLog('thread.fast.refused', { thread: session.terminalId, tier: send, reason: err.message }, 'warn');
        res = await call(undefined);
      }
    }
    // codex-cli 0.167 reports the tier in effect as `serviceTier` on the thread/start and thread/resume answer
    // (measured: `priority` when applied; null when Codex dropped it, for a tier the account does not offer).
    const answer = res as { serviceTier?: unknown } | undefined;
    const reportsTier = !!answer && typeof answer === 'object' && 'serviceTier' in answer;
    const reported = answer?.serviceTier;
    session.serviceTier = typeof reported === 'string' && reported ? reported : undefined;
    if (asked && !reportsTier) {
      // An answer with no tier field says nothing either way: not a refusal.
      boxLog('thread.fast.unreported', { thread: session.terminalId, tier: asked });
    } else if (asked && session.serviceTier !== asked && !session.tierRefused) {
      session.tierRefused = true;
      const offered = session.model ? this.effortCache?.tiers?.[session.model] : undefined;
      const reason = offered && !offered.includes(asked) ? 'the account does not offer this tier for the model' : 'Codex did not apply the tier';
      boxLog('thread.fast.refused', { thread: session.terminalId, tier: asked, reported: session.serviceTier ?? null, reason }, 'warn');
    }
    return res;
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
    logThreadModel(session.terminalId, 'codex', session.model ?? null, model ?? null, { serviceTier: session.serviceTier ?? null, serviceTierAsked: session.serviceTierAsked ?? null });
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
    // W3-D: this is history that Codex keeps itself (the transcript route reads it). It goes in the
    // ring and to the viewers as before, and NOT in the message journal: as a replay, the recorder
    // marks each event and writes none. Without this, each resume (a daemon restart, a recovery
    // of the app-server) wrote the whole history again with new sequences.
    session.recorder?.beginReplay();
    try {
      for (const turn of turns) {
        for (const item of Array.isArray(turn?.items) ? turn.items : []) {
          for (const ev of backfillItem(item)) this.pushEvent(session, ev);
        }
      }
    } finally { session.recorder?.endReplay(); }
  }

  private onConnExit(conn: JsonRpcStdioClient): void {
    if (this.conn !== conn) return; // a newer connection already replaced it
    this.conn = undefined;
    this.threadToTerminal.clear();
    for (const sub of this.subThreads.values()) if (sub.finishTimer) clearTimeout(sub.finishTimer);
    this.subThreads.clear();
    this.deadSubThreads.clear();
    const live = [...this.sessions.values()];
    if (live.length === 0 || !this.connSpec) return;
    // Crash recovery: respawn the shared server and thread/resume every live thread by id.
    const conn2 = this.makeConnection(this.connSpec);
    this.conn = conn2;
    for (const session of live) {
      session.recorder?.close(); // W3-D: a block that streamed when the app-server died is written
      session.pending = null;
      session.pendingApproval = null;
      session.approvalQueue = [];
      session.agentResults = [];
      session.delivering = false;
      // The sub-threads lived in the app-server that died: they are gone.
      session.subagents.stopAll('The Codex app-server stopped.');
      session.subagents.dispose();
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
    // A sub-thread announces itself (its parent is a thread we route): bind it before routing.
    if (method === 'thread/started') this.maybeBindSubThread(params?.thread);
    const routed = this.routeSession(method, params);
    if (!routed) return;
    const { session, sub } = routed;
    if (sub) { this.onSubNotification(session, sub, method, params); return; }
    const eventTurnId = params?.turnId ?? params?.turn?.id;
    if (method !== 'turn/started' && eventTurnId && session.currentTurnId && eventTurnId !== session.currentTurnId) return;
    // Track turn liveness for interrupt/steer BEFORE translating (the translator only emits UI).
    if (method === 'turn/started') { session.turnActive = true; session.currentTurnId = params?.turn?.id; session.delivering = false; }
    else if (method === 'turn/completed') { session.turnActive = false; }
    if (method === 'item/autoApprovalReview/completed') this.onReviewCompleted(session, params);
    if (method === 'item/started' || method === 'item/completed') this.observeAgentItem(session, session.threadId ?? null, params?.item);
    const actions = session.translator.translate({ method, params });
    if (method === 'turn/completed') {
      // Only a normal end may be followed by a delivery: not a usage limit, an error, an interrupt or a question.
      const normal = params?.turn?.status === 'completed' && actions.every((a) => a.kind !== 'failed' && a.kind !== 'usage-limit' && a.kind !== 'needs-help');
      session.lastMainEnd = normal ? 'normal' : 'other';
      // Subagent results that came while this turn ran reach the main agent now, BEFORE the turn end
      // settles: the delivery turn's own end settles the thread, so no idle (and no "done" notice) goes out between.
      if (normal && this.deliverAgentResults(session)) {
        this.applyActions(session, actions.filter((a) => a.kind !== 'idle'));
        return;
      }
    }
    this.applyActions(session, actions);
  }

  private onServerRequest(method: string, id: RpcId, params: any): void {
    const routed = this.routeSession(method, params);
    if (!routed) { this.conn?.respondError(id, METHOD_NOT_FOUND, 'no session for request'); return; }
    const { session, sub } = routed;
    // A sub-thread's request is translated by its own translator (its item cache) and runs through
    // the SAME membrane as the main thread's (subagents-v1): the policy, then the person or auto-allow.
    const actions = (sub?.translator ?? session.translator).translate({ method, params, id });
    // A recognized approval yields exactly one approval action; anything else we can't answer.
    if (!actions.some((a) => a.kind === 'approval')) { this.conn?.respondError(id, METHOD_NOT_FOUND, 'unhandled server request'); return; }
    if (sub) { for (const a of actions) if (a.kind === 'approval') this.handleApproval(session, a, sub); return; }
    this.applyActions(session, actions);
  }

  /** Resolve the session a frame belongs to via its threadId (thread/started carries it as
   *  thread.id): the main thread of a session, or one of its sub-threads. Frames that predate the
   *  thread binding are dropped. */
  private routeSession(method: string, params: any): { session: CodexSession; sub?: SubThread } | undefined {
    const threadId: string | undefined = method === 'thread/started' ? params?.thread?.id : params?.threadId;
    if (typeof threadId !== 'string') return undefined;
    const terminalId = this.threadToTerminal.get(threadId);
    if (terminalId) {
      const session = this.sessions.get(terminalId);
      return session ? { session } : undefined;
    }
    const sub = this.subThreads.get(threadId);
    const session = sub ? this.sessions.get(sub.terminalId) : undefined;
    return sub && session ? { session, sub } : undefined;
  }

  // --- subagents (sub-threads) ---------------------------------------------------------------

  /** `thread/started` of a sub-thread whose parent we route (Thread.parentThreadId, or its spawn source). */
  private maybeBindSubThread(thread: any): void {
    const id = thread?.id;
    if (typeof id !== 'string' || !id || this.threadToTerminal.has(id) || this.deadSubThreads.has(id)) return;
    const source = thread?.source;
    const spawn = source?.subagent?.thread_spawn ?? source?.subAgent?.thread_spawn;
    const parent = typeof thread?.parentThreadId === 'string' && thread.parentThreadId ? thread.parentThreadId : spawn?.parent_thread_id;
    if (typeof parent !== 'string' || !parent) return;
    this.bindSubThread(id, parent, {
      title: titleFromAgentPath(spawn?.agent_path) ?? (typeof thread?.agentNickname === 'string' && thread.agentNickname ? thread.agentNickname : undefined),
      kind: str(thread?.agentRole) ?? str(spawn?.agent_role),
      model: str(thread?.model),
      effort: str(thread?.reasoningEffort),
      nativeId: str(spawn?.agent_path),
    });
  }

  /**
   * Route a sub-thread's frames to the session that owns `parentThreadId` (its main thread, or the
   * sub-thread above it). Called only with a parent that a spawn names: the sub-thread's own
   * `thread/started`, a `subAgentActivity` of kind `started`, a `collabAgentToolCall` spawnAgent. A
   * sub-thread is never re-bound to another thread, and one of a stopped thread is never bound again.
   */
  private bindSubThread(id: string, parentThreadId: string, init: Partial<SubagentInfo>): SubThread | undefined {
    if (this.threadToTerminal.has(id) || this.deadSubThreads.has(id)) return undefined; // a Dispatch thread of its own, or a dead one
    const parentSub = this.subThreads.get(parentThreadId);
    const terminalId = this.threadToTerminal.get(parentThreadId) ?? parentSub?.terminalId;
    const session = terminalId ? this.sessions.get(terminalId) : undefined;
    if (!terminalId || !session) return undefined;
    let sub = this.subThreads.get(id);
    if (sub && sub.terminalId !== terminalId) return undefined; // owned by another thread: change nothing
    if (!sub) {
      sub = { id, terminalId, parentId: parentSub ? parentSub.id : null, translator: new CodexTranslator(), turnActive: false };
      this.subThreads.set(id, sub);
    }
    if (init.model) sub.translator.setModel(init.model);
    session.subagents.ensure(id, { parentId: sub.parentId, ...init });
    return sub;
  }

  /** One frame of a sub-thread: translated by its own translator, tagged with its id, and its state kept. */
  private onSubNotification(session: CodexSession, sub: SubThread, method: string, params: any): void {
    const eventTurnId = params?.turnId ?? params?.turn?.id;
    if (method !== 'turn/started' && eventTurnId && sub.currentTurnId && eventTurnId !== sub.currentTurnId) return;
    const tracker = session.subagents;
    tracker.touch(sub.id);
    if (method === 'turn/started') {
      sub.turnActive = true;
      sub.currentTurnId = params?.turn?.id;
      // The person stopped it before this turn began: stop the turn now (M1).
      if (sub.stopRequested && sub.currentTurnId && this.conn?.alive) void this.conn.request('turn/interrupt', { threadId: sub.id, turnId: sub.currentTurnId }).catch(() => {});
    } else if (method === 'turn/completed') {
      sub.turnActive = false;
      this.dropQueuedFor(session, sub.id, 'The subagent turn ended.'); // its waiting requests are dead
    }
    if (method === 'item/started' && params?.item && !NON_TOOL_ITEM_TYPES.has(params.item.type)) tracker.step(sub.id);
    if (method === 'item/started' || method === 'item/completed') this.observeAgentItem(session, sub.id, params?.item);
    if (method === 'item/autoApprovalReview/completed') this.onReviewCompleted(session, params, sub);
    if (method === 'thread/tokenUsage/updated') {
      const total = params?.tokenUsage?.total;
      if (total && typeof total.inputTokens === 'number' && typeof total.outputTokens === 'number') {
        tracker.update(sub.id, { tokens: total.inputTokens + total.outputTokens, usage: { input: total.inputTokens, output: total.outputTokens } });
      }
    }
    if (method === 'thread/status/changed' && params?.status?.type === 'systemError') this.finishSubagent(session, sub.id, 'failed', undefined, 'The subagent stopped on an error.');
    const turnStatus = method === 'turn/completed' ? params?.turn?.status : undefined;
    for (const action of sub.translator.translate({ method, params })) {
      switch (action.kind) {
        case 'event':
          this.pushEvent(session, tagParent(this.withDenyReason(session, action.event), sub.id));
          break;
        case 'busy':
          if (!sub.stopRequested) tracker.update(sub.id, { state: 'working' }, { revive: true });
          break;
        case 'idle':
        case 'needs-help':
          if (action.summary) sub.lastResult = action.summary;
          this.finishSubagent(session, sub.id, turnStatus === 'interrupted' || sub.stopRequested ? 'stopped' : 'done', action.summary, undefined, undefined, true);
          break;
        case 'failed':
          this.finishSubagent(session, sub.id, 'failed', undefined, typeof params?.turn?.error?.message === 'string' ? params.turn.error.message : 'The subagent could not finish.');
          break;
        case 'usage-limit':
          this.finishSubagent(session, sub.id, 'failed', undefined, 'The subagent stopped on a usage limit.');
          break;
        default:
          break; // 'session' (its own id) and approvals (requests only) are not for the main thread
      }
    }
  }

  /**
   * The items that tell about subagents, in the main thread or in a sub-thread (`emitter` = its id):
   *  - `subAgentActivity` (started | interacted | interrupted | completed), one item per activity;
   *  - `collabAgentToolCall` (spawnAgent with receiverThreadIds; agentsStates on every collab tool).
   */
  private observeAgentItem(session: CodexSession, emitter: string | null, item: any): void {
    if (!item || typeof item !== 'object') return;
    const tracker = session.subagents;
    if (item.type === 'subAgentActivity' && typeof item.agentThreadId === 'string' && item.agentThreadId) {
      const id = item.agentThreadId;
      // Only a `started` item binds (it is the spawn); every other kind must name a subagent of this thread.
      if (item.kind === 'started' && emitter) this.bindSubThread(id, emitter, {
        title: titleFromAgentPath(item.agentPath), model: str(item.model), effort: str(item.reasoningEffort),
        nativeId: str(item.agentPath), callId: str(item.id),
        startedAt: typeof item.startedAtMs === 'number' ? item.startedAtMs : undefined,
      });
      if (!this.ownsAgent(session, id)) return;
      tracker.touch(id);
      switch (item.kind) {
        case 'interacted': if (!this.subThreads.get(id)?.stopRequested) tracker.update(id, { state: 'working' }, { revive: true }); break;
        case 'interrupted': this.finishSubagent(session, id, 'stopped'); break;
        case 'completed':
          this.finishSubagent(session, id, 'done', undefined, undefined, typeof item.completedAtMs === 'number' ? item.completedAtMs : undefined);
          break;
        default: break;
      }
      return;
    }
    if (item.type !== 'collabAgentToolCall') return;
    const receivers: string[] = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((x: unknown): x is string => typeof x === 'string' && !!x) : [];
    if (item.tool === 'spawnAgent' && emitter) {
      // The sender must be the thread that sent the item (or a sub-thread of this thread).
      const sender = str(item.senderThreadId) ?? emitter;
      const senderOk = sender === emitter || this.subThreads.get(sender)?.terminalId === session.terminalId;
      for (const rid of senderOk ? receivers : []) {
        this.bindSubThread(rid, sender, { prompt: str(item.prompt), model: str(item.model), effort: str(item.reasoningEffort), callId: str(item.id), title: firstLine(item.prompt) });
      }
    }
    const states = item.agentsStates && typeof item.agentsStates === 'object' ? item.agentsStates : {};
    for (const [rid, st] of Object.entries(states as Record<string, any>)) {
      if (!this.ownsAgent(session, rid)) continue;
      const message = str(st?.message);
      switch (st?.status) {
        case 'running': tracker.touch(rid); tracker.update(rid, { state: 'working' }); break;
        case 'completed': this.finishSubagent(session, rid, 'done', message); break;
        case 'errored': case 'notFound': this.finishSubagent(session, rid, 'failed', undefined, message ?? 'The subagent could not finish.'); break;
        case 'interrupted': case 'shutdown': this.finishSubagent(session, rid, 'stopped'); break;
        default: break;
      }
      // The main agent read this result itself (a `wait`): it needs no delivery.
      if (item.tool === 'wait' && emitter === session.threadId) session.agentResults = session.agentResults.filter((r) => r.id !== rid);
    }
  }

  /**
   * A subagent ended. Its result goes to the main agent (decision 2026-11-12): Claude Code wakes its
   * main agent for a finished background agent by itself, Codex does not, so the daemon does. A
   * top-level subagent that ended done or failed is queued; when the main turn is not running, a
   * main turn starts now with it (deliverAgentResults), else at that turn's end. The delivery comes
   * first, then the state: a turn start drops the held idle, so the thread never flips to idle between.
   */
  private finishSubagent(session: CodexSession, id: string, state: SubagentState, result?: string, error?: string, endedAt?: number, ownTurnEnd = false): void {
    const tracker = session.subagents;
    const a = tracker.get(id);
    const sub = this.subThreads.get(id);
    if (sub?.finishTimer) { clearTimeout(sub.finishTimer); sub.finishTimer = undefined; }
    if (!a || !RUNNING_STATES.has(a.state)) {
      // Already ended: keep a result or reason that the first end did not have.
      if (a && (result || error)) tracker.update(id, { ...(a.result ? {} : { result }), ...(a.error ? {} : { error }) });
      return;
    }
    // An end reported by an item (`completed`, agentsStates) before the sub-thread's own turn end has no
    // final text yet: wait for that turn end (at most FINISH_WAIT_MS), so the main agent never gets an empty result.
    if (state === 'done' && !result && !ownTurnEnd && sub?.turnActive) {
      sub.finishTimer = setTimeout(() => { sub.finishTimer = undefined; this.finishSubagent(session, id, state, sub.lastResult, undefined, endedAt, true); }, FINISH_WAIT_MS);
      sub.finishTimer.unref?.();
      return;
    }
    if (state === 'done' && !result) result = sub?.lastResult;
    if (a.parentId === null && (state === 'done' || state === 'failed')) {
      session.agentResults.push({ id, title: a.title, state, text: (state === 'done' ? result : error) ?? '' });
      if (!session.turnActive) this.deliverAgentResults(session);
    }
    tracker.update(id, { state, ...(result ? { result } : {}), ...(error ? { error } : {}), ...(endedAt ? { endedAt } : {}) });
  }

  /** True when `id` is a subagent of THIS thread (its tracker has it and no other thread owns its sub-thread). */
  private ownsAgent(session: CodexSession, id: string): boolean {
    if (!session.subagents.has(id)) return false;
    const sub = this.subThreads.get(id);
    return !sub || sub.terminalId === session.terminalId;
  }

  /**
   * Start one main turn that hands the queued subagent results to the main agent. The input is a
   * `<task-notification>` block per result (the shape Claude Code uses for the same event), so every
   * reader shows it as a notice and never as the person's message (conversation/task-notification.ts);
   * its echo is also marked `meta.internal`.
   */
  private deliverAgentResults(session: CodexSession): boolean {
    if (session.turnActive || session.delivering || !session.agentResults.length || this.sessions.get(session.terminalId) !== session) return false;
    // Not after the person stopped the reply, not while the thread waits for the person, not after a
    // turn that ended on an error, a usage limit or a question: the results wait for the next message.
    if (session.deliveryPaused || session.pending || session.lastMainEnd === 'other') return false;
    // A cap on the turns the daemon starts by itself (a main agent that starts a subagent in each turn
    // would otherwise run with no person): past it, one notice, and the results wait for the next message.
    if (session.autoTurns >= this.autoTurnLimit) {
      if (!session.capNoticed) {
        session.capNoticed = true;
        this.pushEvent(session, { type: 'system', subtype: 'dispatch_notice', level: 'warning', message: 'Agents finished; ask to see their results.' });
      }
      return false;
    }
    session.autoTurns += 1;
    const results = session.agentResults;
    session.agentResults = [];
    const content: ContentBlock[] = results.map((r) => ({ type: 'text', text: subagentResultText(r) }));
    this.pushEvent(session, { type: 'user', message: { role: 'user', content }, meta: { source: 'dispatch', internal: true, subagents: results.map((r) => r.id) } });
    session.subagents.turnStarted();
    session.delivering = true; // the turn/start below is on its way: a second delivery waits for that turn's end
    this.fire('busy', session.terminalId);
    session.ready = session.ready.then(() => this.startTurn(session, content)).catch((err) => {
      if (this.sessions.get(session.terminalId) !== session) return;
      session.delivering = false;
      this.pushEvent(session, { type: 'result', subtype: 'error', is_error: true, result: String(err) });
      this.fire('failed', session.terminalId);
    });
    return true;
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
          session.subagents.turnStarted();
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
          // A subagent still runs (subagents-v1): the thread stays working; the idle is let go when the
          // last subagent ends, unless a delivered result starts the next main turn first.
          if (action.kind === 'idle' && session.declared?.state !== 'needs_you' && session.subagents.running().length) {
            const declared = session.declared;
            session.declared = undefined;
            session.subagents.holdIdle(() => settleTurn({ terminalId: session.terminalId, declared }, action, this.settleDeps));
            break;
          }
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
  private handleApproval(session: CodexSession, action: Extract<TranslatedAction, { kind: 'approval' }>, sub?: SubThread): void {
    // A subagent's request names its subagent, so a view finds it (subagents-v1).
    if (sub) action = { ...action, pending: { ...action.pending, agentId: sub.id } };
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
      this.declineWithReason(session, action, 'Dispatch policy: a governed thread cannot change its own sandbox or approval permissions — hand work that needs elevated access to an agent or a human.', { pairToolUse: true }, sub);
      return;
    }
    // AskUserQuestion's Codex analogue can't be auto-answered with a real decision — same
    // exemption the Claude manager gives AskUserQuestion — so it never runs through the policy.
    if (!action.alwaysSurface && session.toolPolicy) {
      const adapted = adaptForPolicy('codex', { toolName: action.pending.toolName, input: action.pending.input });
      const verdict = session.toolPolicy(adapted.toolName, adapted.input);
      if (!verdict.allow) {
        this.declineWithReason(session, action, verdict.message, { pairToolUse: false }, sub);
        return;
      }
    }
    if (session.escalate || action.alwaysSurface) {
      const queued: QueuedApproval = { pending: action.pending, approval: { method: action.method, requestId: action.requestId } };
      if (sub) session.subagents.update(sub.id, { state: 'needs_input' }, { revive: true });
      // One request is in front of the person at a time; a second one (a subagent and the main agent
      // ask together) waits its turn and is surfaced when the first is answered.
      if (session.pending) { session.approvalQueue.push(queued); return; }
      this.surface(session, queued);
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
    sub?: SubThread,
  ): void {
    this.conn?.respond(action.requestId, buildApprovalResponse(action.method, { behavior: 'deny', message }, action.pending));
    const toolUseId = action.pending.toolUseId;
    const push = (event: unknown) => this.pushEvent(session, sub ? tagParent(event, sub.id) : event);
    if (opts.pairToolUse) {
      push({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: action.pending.toolName, input: action.pending.input }] },
      });
    }
    if (toolUseId) session.deniedReasons.set(toolUseId, message);
    push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: message, is_error: true }] },
    });
  }

  /** Put one request in front of the person. */
  private surface(session: CodexSession, q: QueuedApproval): void {
    session.pending = q.pending;
    session.pendingApproval = q.approval;
    this.fire('permission', session.terminalId, q.pending);
  }

  /** The surfaced request was answered: its subagent works again, and the next waiting request (if any) is surfaced. */
  private afterAnswer(session: CodexSession, answered: PendingPermission): void {
    if (answered.agentId && !session.approvalQueue.some((q) => q.pending.agentId === answered.agentId)) {
      session.subagents.update(answered.agentId, { state: 'working' });
    }
    const next = session.approvalQueue.shift();
    if (next) this.surface(session, next);
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
    // SENT_MARK: a sent message, never classified as harness context (journal/recorder.ts).
    const ev: any = { type: 'user', message: { role: 'user', content: echoContent }, [SENT_MARK]: true };
    if (source) ev.meta = { source };
    this.pushEvent(session, ev);
    session.subagents.turnStarted(); // a new main turn: a held idle belongs to a turn that is over
    // The PERSON's message (source 'user': the web page and the OS view send it) starts a new run: automatic
    // turns may follow it again, and a delivery that a Stop paused may go at its end. A peer's message or the
    // daemon's own (no source: a notice, the continue prompt after a restart) changes neither (review N4).
    if (source === 'user') { session.autoTurns = 0; session.capNoticed = false; session.deliveryPaused = false; }
    session.lastMainEnd = undefined;
    this.fire('busy', terminalId);
    // Deliver once the thread is started (queued via the ready promise if still starting).
    session.ready = session.ready.then(() => this.startTurn(session, content)).catch((err) => {
      if (this.sessions.get(terminalId) !== session) return;
      this.pushEvent(session, { type: 'result', subtype: 'error', is_error: true, result: shown(err) });
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
        // The turn's error result says the same plain sentence (the view shows it on the failed turn).
        if (err instanceof CodexRpcError) throw refusedRequest(err);
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

  /** Another approval waits behind the one in front (the queue of sub-thread approvals): an answer must then name its request. */
  hasWaitingPermission(terminalId: string): boolean {
    return (this.sessions.get(terminalId)?.approvalQueue.length ?? 0) > 0;
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

  postEvent(terminalId: string, event: Record<string, unknown>): void {
    const session = this.sessions.get(terminalId);
    if (session) this.pushEvent(session, event);
  }

  /** The reviewer denied an action (critical risk, or it judged it unsafe): a card with its risk and rationale. */
  private onReviewCompleted(session: CodexSession, params: any, sub?: SubThread): void {
    const review = params?.review;
    if (review?.status !== 'denied') return;
    const { toolName, detail } = describeReviewAction(params?.action);
    const block: BlockedAction = {
      id: typeof params?.reviewId === 'string' ? params.reviewId : randomUUID(),
      toolName, title: approvalTitle(toolName), detail,
      reason: typeof review.rationale === 'string' ? review.rationale : null,
      riskLevel: typeof review.riskLevel === 'string' ? review.riskLevel : null,
      at: Date.now(),
      ...(sub ? { agentId: sub.id } : {}),
    };
    // The override names the thread whose action was denied: a sub-thread's own id for a subagent.
    session.blocked = [...(session.blocked ?? []).filter((x) => x.block.id !== block.id), { block, raw: params, threadId: sub?.id ?? session.threadId }].slice(-20);
    this.pushEvent(session, blockedEvent(block));
  }

  async setApprovals(terminalId: string, mode: Approvals): Promise<void> {
    const session = this.sessions.get(terminalId);
    if (!session) throw new Error('This thread is not running');
    // Codex reads approvalPolicy/sandbox/reviewer at thread/start or thread/resume: the change
    // holds from the next start of this thread; the membrane side applies at once.
    session.smart = mode === 'smart' && !session.toolPolicy;
    this.setEscalate(terminalId, mode !== 'auto');
  }

  getBlocked(terminalId: string): BlockedAction[] {
    return (this.sessions.get(terminalId)?.blocked ?? []).map((b) => b.block);
  }

  async resolveBlocked(terminalId: string, id: string, decision: 'allow' | 'keep'): Promise<boolean> {
    const session = this.sessions.get(terminalId);
    const hit = session?.blocked?.find((b) => b.block.id === id);
    if (!session || !hit) return false;
    session.blocked = session.blocked!.filter((b) => b.block.id !== id);
    this.pushEvent(session, blockedResolvedEvent(id, decision));
    if (decision !== 'allow') return true;
    // Codex's own override, a request only the daemon sends. Its `event` is a serialized
    // GuardianAssessmentEvent; we hand back the review notification we got (UNTESTED against a real
    // denial). If Codex refuses it, NOTHING is allowed: no sentence in the conversation stands in for
    // the person's decision (os/approvals.ts). The person asks again and is asked first.
    try {
      if (!this.conn || !session.threadId) throw new Error('no thread');
      await this.conn.request('thread/approveGuardianDeniedAction', { threadId: hit.threadId ?? session.threadId, event: hit.raw });
    } catch {
      this.pushEvent(session, { type: 'system', subtype: 'dispatch_notice', level: 'warning', message: 'Dispatch could not allow that action. Ask for it again: you will be asked before it runs.' });
    }
    return true;
  }

  postNotice(terminalId: string, message: string): void {
    const session = this.sessions.get(terminalId);
    if (session) this.pushEvent(session, { type: 'system', subtype: 'settings_refused', message });
  }

  /** The efforts each model takes, from the last `model/list` (see loadModelEfforts), or null if never asked. */
  modelEfforts(): Record<string, string[]> | null { return this.effortCache?.map ?? null; }
  /** The effort each model runs at by default, from the same `model/list`. */
  modelDefaultEfforts(): Record<string, string> | null { return this.effortCache?.defaults ?? null; }
  /** The service tier ids each model offers, from the same `model/list` (codex-fast.ts), or null if never asked. */
  modelServiceTiers(): Record<string, string[]> | null { return this.effortCache?.tiers ?? null; }

  /** The tier this thread asks for (hosted: the fast tier, unless switched off or the model does not offer it). */
  private serviceTierFor(session: CodexSession): string | undefined {
    if (session.tierRefused) return undefined;
    return codexServiceTier(session.model, (m) => this.effortCache?.tiers?.[m] ?? null);
  }

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
      const tiers: Record<string, string[]> = {};
      const defaults: Record<string, string> = {};
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const res: any = await conn.request('model/list', { includeHidden: true, limit: 100, ...(cursor ? { cursor } : {}) }, this.modelListTimeoutMs);
        for (const m of res?.data ?? []) {
          const efforts = (m?.supportedReasoningEfforts ?? []).map((e: any) => e?.reasoningEffort).filter((e: unknown): e is string => typeof e === 'string' && !!e);
          if (typeof m?.model === 'string') tiers[m.model] = (Array.isArray(m?.serviceTiers) ? m.serviceTiers : []).map((t: any) => t?.id).filter((t: unknown): t is string => typeof t === 'string' && !!t);
          if (typeof m?.model === 'string' && efforts.length) {
            map[m.model] = efforts;
            if (typeof m?.defaultReasoningEffort === 'string' && efforts.includes(m.defaultReasoningEffort)) defaults[m.model] = m.defaultReasoningEffort;
          }
        }
        cursor = typeof res?.nextCursor === 'string' && res.nextCursor ? res.nextCursor : null;
        if (!cursor) break;
      }
      if (Object.keys(map).length) {
        this.effortCache = { at: Date.now(), map, defaults, tiers };
        // The service tiers the signed-in account offers per model (they depend on the account): one line
        // per read, so the box log answers "is Fast available here?" directly.
        boxLog('codex.tiers', { tiers: Object.fromEntries(Object.entries(tiers).filter(([, t]) => t.length)) });
      }
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
    const answered = session.pending;
    session.pending = null;
    session.pendingApproval = null;
    this.fire('resolved', terminalId);
    this.afterAnswer(session, answered);
    return true;
  }

  setEscalate(terminalId: string, escalate: boolean): boolean {
    const session = this.sessions.get(terminalId);
    if (!session) return false;
    session.escalate = escalate;
    // Going autonomous with a PLAIN gated approval pending (not an AskUserQuestion) → auto-allow
    // it immediately so a supervised thread unblocks the moment the user flips the dial.
    if (!escalate) {
      // The waiting requests that are plain approvals are allowed too; a question still waits for the person.
      const keep: QueuedApproval[] = [];
      for (const q of session.approvalQueue) {
        if (q.approval.method === 'item/tool/requestUserInput') { keep.push(q); continue; }
        this.conn?.respond(q.approval.requestId, buildApprovalResponse(q.approval.method, { behavior: 'allow' }, q.pending));
        if (q.pending.agentId) session.subagents.update(q.pending.agentId, { state: 'working' });
      }
      session.approvalQueue = keep;
    }
    if (!escalate && session.pending && session.pendingApproval && session.pendingApproval.method !== 'item/tool/requestUserInput') {
      const response = buildApprovalResponse(session.pendingApproval.method, { behavior: 'allow' }, session.pending);
      this.conn?.respond(session.pendingApproval.requestId, response);
      const answered = session.pending;
      session.pending = null;
      session.pendingApproval = null;
      this.fire('resolved', terminalId);
      this.afterAnswer(session, answered);
    }
    return true;
  }

  interrupt(terminalId: string): boolean {
    const session = this.sessions.get(terminalId);
    if (session) session.deliveryPaused = true; // the person stopped the reply: no turn starts by itself after it
    if (!session || !this.conn?.alive || !session.threadId || !session.currentTurnId) return false;
    void this.conn.request('turn/interrupt', { threadId: session.threadId, turnId: session.currentTurnId }).catch(() => {});
    return true;
  }

  /** The subagents of a live thread, oldest first (subagents-v1). null: no live session. */
  listSubagents(terminalId: string): SubagentInfo[] | null {
    return this.sessions.get(terminalId)?.subagents.list() ?? null;
  }

  /**
   * Stop one subagent: `turn/interrupt` on its sub-thread's current turn. Its sub-thread then ends the
   * turn as `interrupted`, which marks it `stopped`. A stopped subagent's result is not delivered to the
   * main agent (the person stopped it).
   */
  async stopSubagent(terminalId: string, agentId: string): Promise<StopAgentResult> {
    const session = this.sessions.get(terminalId);
    const a = session?.subagents.get(agentId);
    if (!session || !a) return 'not-found';
    if (!RUNNING_STATES.has(a.state)) return 'not-running';
    const sub = this.subThreads.get(agentId);
    if (!sub || sub.terminalId !== terminalId || !this.conn?.alive) return 'unsupported';
    sub.stopRequested = true; // a turn it starts later is interrupted at its start (onSubNotification)
    if (sub.turnActive && sub.currentTurnId) {
      try {
        await this.conn.request('turn/interrupt', { threadId: sub.id, turnId: sub.currentTurnId });
      } catch {
        sub.stopRequested = false;
        return 'unsupported';
      }
    }
    // Answer any request of this subagent that waits for the person: its turn is gone.
    this.dropQueuedFor(session, agentId);
    if (sub.turnActive || RUNNING_STATES.has(session.subagents.get(agentId)?.state ?? 'done')) this.finishSubagent(session, agentId, 'stopped');
    return 'stopped';
  }

  /** Stop every running subagent, and the main turn when it runs. */
  async stopAllSubagents(terminalId: string): Promise<{ stopped: string[]; unsupported: string[]; mainInterrupted: boolean }> {
    const session = this.sessions.get(terminalId);
    if (!session) return { stopped: [], unsupported: [], mainInterrupted: false };
    const out = { stopped: [] as string[], unsupported: [] as string[], mainInterrupted: false };
    session.deliveryPaused = true; // no turn starts by itself after a stop of everything
    for (const a of session.subagents.running()) {
      const r = await this.stopSubagent(terminalId, a.id);
      if (r === 'stopped') out.stopped.push(a.id);
      else if (r === 'unsupported') out.unsupported.push(a.id);
    }
    if (session.turnActive) out.mainInterrupted = this.interrupt(terminalId);
    return out;
  }

  /** A sub-thread's history as Claude-shaped events tagged with its id (`thread/read`), for the agent journal route. */
  async readSubagentHistory(terminalId: string, agentId: string): Promise<unknown[] | null> {
    const session = this.sessions.get(terminalId);
    if (!session?.subagents.has(agentId) || this.subThreads.get(agentId)?.terminalId !== terminalId || !this.conn?.alive) return null;
    try {
      const res = await this.conn.request('thread/read', { threadId: agentId, includeTurns: true }, this.releaseTimeoutMs);
      const turns: any[] = Array.isArray(res?.thread?.turns) ? res.thread.turns : [];
      const out: unknown[] = [];
      for (const turn of turns) for (const item of Array.isArray(turn?.items) ? turn.items : []) for (const ev of backfillItem(item)) out.push(tagParent(ev, agentId));
      return out;
    } catch {
      return null;
    }
  }

  /** Requests of a stopped subagent that wait in the queue are declined (its turn will not use them). */
  private dropQueuedFor(session: CodexSession, agentId: string, why = 'The subagent was stopped.'): void {
    const keep: QueuedApproval[] = [];
    for (const q of session.approvalQueue) {
      if (q.pending.agentId !== agentId) { keep.push(q); continue; }
      this.conn?.respond(q.approval.requestId, buildApprovalResponse(q.approval.method, { behavior: 'deny', message: why }, q.pending));
    }
    session.approvalQueue = keep;
    if (session.pending?.agentId === agentId && session.pendingApproval) {
      this.conn?.respond(session.pendingApproval.requestId, buildApprovalResponse(session.pendingApproval.method, { behavior: 'deny', message: why }, session.pending));
      session.pending = null;
      session.pendingApproval = null;
      this.fire('resolved', session.terminalId);
      const next = session.approvalQueue.shift();
      if (next) this.surface(session, next);
    }
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
    session.approvalQueue = [];
    session.subagents.stopAll('The session ended.'); // written while the session can still emit
    session.subagents.dispose();
    // Its sub-threads run in the shared app-server: stop their turns and let them go, and never bind them again.
    for (const [id, sub] of this.subThreads) {
      if (sub.terminalId !== terminalId) continue;
      if (sub.finishTimer) clearTimeout(sub.finishTimer);
      this.subThreads.delete(id);
      this.deadSubThreads.add(id);
      if (this.conn?.alive) {
        if (sub.turnActive && sub.currentTurnId) void this.conn.request('turn/interrupt', { threadId: id, turnId: sub.currentTurnId }).catch(() => {});
        this.releaseThread(this.conn, id);
      }
    }
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

/**
 * approvalPolicy, sandbox and reviewer of thread/start + thread/resume. Smart approvals (an ungoverned
 * thread only): `on-request` + `workspace-write` + `approvalsReviewer: 'auto_review'` — Codex's own
 * reviewer lets low/medium risk run, denies critical, and hands high risk to the person. Names
 * verified against the codex-cli 0.167.0 app-server schema (generate-ts, 2026-11-11).
 */
function approvalParams(session: CodexSession, policy: string, sandbox: string): Record<string, unknown> {
  // On a hosted box the box is the sandbox (hostedSandbox(), owner decision 2026-11-13): Codex's own
  // sandbox cannot start there, so asking for it would fail every shell call.
  if (session.smart && !session.toolPolicy) return { approvalPolicy: 'on-request', sandbox: hostedSandbox() ?? 'workspace-write', approvalsReviewer: 'auto_review' };
  return { approvalPolicy: session.approvalPolicy ?? policy, sandbox: session.sandbox ?? sandbox, ...governedReviewer(session) };
}

/** A plain one-line description of a reviewed action (GuardianApprovalReviewAction). */
export function describeReviewAction(a: any): { toolName: string; detail: string | null } {
  switch (a?.type) {
    case 'command': return { toolName: 'Bash', detail: typeof a.command === 'string' ? a.command : null };
    case 'execve': return { toolName: 'Bash', detail: [a.program, ...(Array.isArray(a.argv) ? a.argv.slice(1) : [])].filter(Boolean).join(' ') || null };
    case 'applyPatch': return { toolName: 'Edit', detail: Array.isArray(a.files) ? a.files.join(', ') : null };
    case 'networkAccess': return { toolName: 'WebFetch', detail: typeof a.target === 'string' ? a.target : a?.host ?? null };
    case 'mcpToolCall': return { toolName: `mcp__${a.server}__${a.toolName}`, detail: a.toolTitle ?? null };
    case 'writeStdin': return { toolName: 'Bash', detail: 'input to a running command' };
    case 'requestPermissions': return { toolName: 'Permissions', detail: a.reason ?? null };
    default: return { toolName: 'tool', detail: null };
  }
}

/** Codex item types that are prose or bookkeeping, not a step (mirrors codex-translate.ts NON_TOOL_ITEMS). */
const NON_TOOL_ITEM_TYPES = new Set(['agentMessage', 'reasoning', 'userMessage', 'hookPrompt', 'plan', 'contextCompaction', 'enteredReviewMode', 'exitedReviewMode', 'subAgentActivity']);

/** An event of a sub-thread, tagged with the subagent's id the way Claude tags a subagent's frames. */
function tagParent(event: unknown, id: string): unknown {
  return event && typeof event === 'object' && !Array.isArray(event) ? { ...(event as Record<string, unknown>), parent_tool_use_id: id } : event;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** The first line of a prompt, short, as a title. */
function firstLine(v: unknown): string | undefined {
  const s = str(v)?.split('\n').map((l) => l.trim()).find(Boolean);
  if (!s) return undefined;
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
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
export function backfillItem(item: any): unknown[] {
  switch (item?.type) {
    case 'userMessage': {
      const text = (Array.isArray(item.content) ? item.content : []).filter((c: any) => c?.type === 'text').map((c: any) => c.text ?? '').join('');
      // Codex's own context in a user item (its environment, the AGENTS.md block): a muted notice, never a bubble.
      if (text && isHarnessContext(text)) return [{ type: 'system', subtype: 'dispatch_notice', level: 'info', message: CONTEXT_NOTICE }];
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
