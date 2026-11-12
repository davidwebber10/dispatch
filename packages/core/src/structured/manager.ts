// packages/core/src/structured/manager.ts
import { EventEmitter } from 'events';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';
import { looksLikeQuestion } from '../status/question.js';
import { broadKillDenial } from './broad-kill-guard.js';
import { childEnv } from '../platform/inherited-env.js';
import { redactKeys } from '../auth/redact-keys.js';
import { detectClaudeLimit, pauseLabel, type UsageLimit } from '../limits/detect.js';
import { killWithGrace } from '../platform/kill-grace.js';
import { authRequiredFrame } from '../auth/auth-failure.js';
import { EventRing } from './shared/event-ring.js';
import type { JournalRecorder, ThreadRecorder } from '../journal/recorder.js';
import { ClaudeStreamCompactor } from './shared/stream-compaction.js';
import { settleTurn, type SettleDeps } from './shared/settle-turn.js';
import { blockedEvent, blockedResolvedEvent, approvalTitle, allowedOnceMessage, sameToolCall, inputDetail, SMART_FALLBACK_NOTICE, ALLOW_ONCE_MS, type BlockedAction, type Approvals } from '../os/approvals.js';
import { boxLog } from '../os/box-log.js';
import { logThreadModel } from './model-log.js';
import { SENT_MARK } from '../conversation/task-notification.js';
import { isHostedBox } from '../os/hosted-mode.js';
import { forbiddenInitTools, initServerNames, unexpectedInitMcpTools, unexpectedServers, unexpectedServersNotice, NO_SERVER_LIST_NOTICE } from '../os/hosted-mcp-policy.js';
import { StructuredEmitter, type AnyStructuredListener, type StructuredListener, type StructuredManagerEventName, type StructuredManagerEvents } from './shared/events.js';

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
  /** The recent events for replay. Its `lastPushAt` is the last CLI frame (IStructuredManager.lastFrameAt):
   *  the events the daemon writes itself (the user echo, a notice) are pushed quiet. */
  ring: EventRing;
  /** Drops a finished message's stream frames from the ring once its whole frames are in (ring only). */
  compactor: ClaudeStreamCompactor;
  /** Writes the finished items of this session to the message journal (W3-D). Absent with no journal. */
  recorder?: ThreadRecorder;
  /** When true, gated tools are surfaced as a Need instead of auto-allowed. */
  escalate: boolean;
  /** Optional per-session tool policy consulted before auto-allow; a deny is written straight
   *  back to the CLI with the policy's message (no pending, no human involvement). */
  toolPolicy?: (toolName: string, input: unknown) => { allow: true } | { allow: false; message: string };
  /** The single in-flight permission request awaiting a human decision, if any. */
  pending: PendingPermission | null;
  /** The last STDERR_TAIL chars of the CLI's stderr. Read so the pipe never fills, and carried
   *  on 'exit': a CLI that dies early often says why only there (#76). */
  stderrTail?: string;
  /** Set when the CLI process has exited, while its streams still drain (see spawn()). */
  exitCode?: number;
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
   * A turn is in flight: set by sendMessage (and by an unprompted assistant frame), cleared at
   * `result`. The CLI also starts turns ITSELF (a background sub-agent or task finishing wakes
   * it) with no message on stdin; without this flag such a turn never emitted 'busy', so its
   * `result` was rejected as turn-already-closed and the thread never settled or reported.
   */
  turnOpen?: boolean;
  /**
   * The agent's own declaration for the CURRENT turn, set by report_status and consumed
   * at the `result` boundary. Same lifecycle as lastToolUse: written mid-turn, read once
   * at turn end, then cleared. It must NOT be applied when the tool fires — `result`
   * lands afterwards and would overwrite it.
   */
  declared?: StatusDeclaration;
  /** A usage limit this turn's frames reported (see limits/detect.ts), read at its `result`. */
  limit?: UsageLimit;
  /** The model the CLI last reported for the lead agent (init, a lead assistant frame, set_model). */
  model?: string;
  /** The account the thread runs on (StructuredSpawnOpts.accountId), for auth_required. */
  accountId?: string;
  /** Smart approvals (os/approvals.ts): --permission-mode auto; every can_use_tool that arrives is surfaced. */
  smart?: boolean;
  /** Smart was asked for but the CLI runs another mode (the model has no auto mode): escalate instead. */
  smartFallback?: boolean;
  /** Smart was switched on live: the init frame reflects the spawn flags, so only `status` frames count. */
  smartLive?: boolean;
  /** A live switch to smart is waiting for the CLI's answer: mode reports before it are stale. */
  smartSwitching?: boolean;
  /** Actions the classifier blocked this session, newest last, for the in-thread cards. */
  blocked?: BlockedAction[];
  /** The full input of each blocked call, by block id (the card shows a short detail only). Never sent to a client. */
  blockedInputs?: Map<string, unknown>;
  /**
   * "Allow this" (os/approvals.ts): the one call the person allowed, held by the daemon. While it is set the
   * CLI runs in its asking mode, so the retry comes to the daemon as a request, and only a request for this
   * very call is answered `allow`. `input` undefined: the blocked call's input is not known, so nothing is
   * answered for the person and the retry shows as an ordinary approval card.
   */
  allowOnce?: { toolName: string; input: unknown; known: boolean; timer: NodeJS.Timeout; /** Turn ends to let pass: the turn that was open when the person allowed the call. */ skipResults: number } | null;
  /** Our own control requests awaiting the CLI's control_response (set_model). */
  controls?: Map<string, { resolve: (r: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  /** StructuredSpawnOpts.mcpExpected: every init frame of the process is checked against it. */
  mcpExpected?: string[] | null;
  /** The model the thread was started with (StructuredSpawnOpts.model; null: the CLI default), for the `thread.model` log line. */
  requestedModel?: string | null;
  /** The `thread.model` line was written for this process (once, at its first init frame). */
  modelLogged?: boolean;
  /** True once an init frame was checked (the first one always logs its servers). */
  mcpChecked?: boolean;
  /** Names already warned about, so a frame each turn does not repeat the same warning. */
  mcpWarned?: Set<string>;
}

/**
 * The environment of a Pretty Claude Code thread. CLAUDE_CODE_ARTIFACT=1 (2026-11-12): print mode
 * (`claude -p`) turns the Artifact tools off by default ("sdk_default_off"), so a Pretty thread had
 * none and the CLI thread had them. It is only a default: a value in the daemon's environment or the
 * thread's env wins. On a HOSTED box never: the Artifact tools publish to the person's claude.ai
 * account, outside the platform (os/hosted-mcp-policy.ts); the spawner passes 0 there and the image's
 * managed policy turns them off.
 */
export function claudeChildEnv(defaultEnv: Record<string, string> | undefined, threadEnv: Record<string, string> | undefined, hosted: boolean = isHostedBox()): Record<string, string> {
  const env = childEnv(defaultEnv, threadEnv);
  if (hosted) env.CLAUDE_CODE_ARTIFACT = '0';
  else if (env.CLAUDE_CODE_ARTIFACT === undefined) env.CLAUDE_CODE_ARTIFACT = '1';
  return env;
}

/** How long a set_model control request may wait for the CLI's answer. */
const CONTROL_TIMEOUT_MS = 15_000;
/** The model Claude Code stamps on frames it wrote itself (an error turn, an interrupt). */
const SYNTHETIC = '<synthetic>';

/** Options accepted by a structured manager's `spawn`. For the Claude manager
 *  `command`/`args` are the `claude` stream-json invocation; for a future Codex
 *  manager they identify how to reach its app-server — but the shape is shared so
 *  `SessionService.spawnStructured` can drive either without branching. */
export interface StructuredSpawnOpts {
  /** Smart approvals (os/approvals.ts). Claude: the command carries --permission-mode auto; Codex: the
   *  auto_review reviewer; Grok/OpenCode: the static rule set. Absent: today's escalate/auto-allow. */
  approvals?: 'smart';
  command: string;
  args: string[];
  workDir: string;
  env?: Record<string, string>;
  escalate?: boolean;
  /** Optional per-session tool policy consulted before auto-allow; a deny is written straight
   *  back to the CLI with the policy's message (no pending, no human involvement). */
  toolPolicy?: (toolName: string, input: unknown) => { allow: true } | { allow: false; message: string };
  seedEvents?: unknown[];
  /**
   * Claude only, on a hosted box: the MCP server names Dispatch passed. The first `system/init`
   * frame's `mcp_servers` is logged (`thread.mcp`, names only), and a name not in this list gives a
   * warning line and a notice in the thread (os/hosted-mcp-policy.ts).
   */
  mcpExpected?: string[];
  /**
   * App-server-style managers (Codex) resume/model out-of-band over JSON-RPC rather than via
   * `args`: `resumeId` is the external thread id to `thread/resume`, `model` the thread's
   * model. The Claude manager encodes both in `command`/`args` (via buildStructuredCommand)
   * and ignores these — they're shared on the interface so `spawnStructured` drives either.
   */
  resumeId?: string;
  model?: string;
  /** Codex only: the effort the owner picked earlier (config.effort), sent with each turn. Claude carries it in argv. */
  effort?: string;
  /**
   * Persona/system prompt for harnesses that inject it out-of-band rather than via argv, e.g.
   * Codex's `thread/start` `developerInstructions` param. Argv-based harnesses (Claude
   * `--append-system-prompt`, Grok `--rules`, OpenCode's config file) already receive the
   * persona via their own existing paths and ignore this field.
   */
  systemPrompt?: string;
  /**
   * Per-spawn override of Codex's approval/sandbox pair (see codex-manager.ts's
   * CodexManagerOptions, which sets the manager-wide construction-time default every spawn
   * falls back to when this is omitted). Lets one specific thread pin its own ask-policy — e.g.
   * a COORDINATOR thread must run `'on-request'` + `'read-only'` so the enforcement membrane
   * (handleApproval's toolPolicy gate) actually fires on every write/command needing write or
   * network: under `'workspace-write'` an in-workspace repo write/`git commit` runs WITHOUT ever
   * surfacing an approval, so the membrane would never see exactly the actions it must block.
   * Wire literals verified live against the installed `codex app-server` (codex-cli 0.155.1) and
   * against its own `generate-ts` protocol bindings (AskForApproval / SandboxMode) — see
   * codex-manager.approval-sandbox.test.ts. Ignored by every other harness's manager.
   */
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /**
   * Codex only: per-thread `config` overrides sent on BOTH thread/start and thread/resume — above
   * all the thread's own MCP servers (the `dispatch` identity: DISPATCH_TERMINAL / DISPATCH_SESSION
   * / DISPATCH_SPAWN_DEPTH). The shared app-server's argv/env belong to whichever thread spawned it
   * first, so per-thread identity must ride here (review finding M3). Keys are dotted config paths
   * (e.g. `mcp_servers.dispatch`), which MERGE with the user's config.toml. Live-verified on
   * codex-cli 0.156.1: each thread gets its own MCP server process with its own env, a thread
   * config wins over an app-server `-c`, and thread/resume applies it. Ignored by other managers.
   */
  threadConfig?: Record<string, unknown>;
  /**
   * The account the thread runs on (config.accountId, else the harness default). Only stamped on a
   * `system/auth_required` event, so the chat can name the signed-out account. Absent for Grok/OpenCode.
   */
  accountId?: string;
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
 *   'idle'   (terminalId, detail)     — a turn completed (thread is idle);
 *                                       detail: { declared: boolean; state?: 'done' | 'blocked';
 *                                       blocker?: string; summary?: string } —
 *                                       `declared` is whether the agent explicitly declared
 *                                       this outcome (report_status done/blocked) vs it being
 *                                       inferred (nothing declared, and the closing-text
 *                                       heuristic didn't read as a question). When `declared` is
 *                                       true, `state` carries WHICH outcome was declared — 'done'
 *                                       or 'blocked' (a declared 'needs_you' never reaches 'idle',
 *                                       see the needs-help branch below) — and, only for 'blocked',
 *                                       `blocker` carries the agent's own text for what it's
 *                                       waiting on, when supplied. Both are absent when `declared`
 *                                       is false. This is what lets a later consumer (see
 *                                       SessionService.noteTurnOutcome) tell a finished thread
 *                                       apart from one merely queued behind another agent — both
 *                                       settle 'idle' (neither needs the human) but they are NOT
 *                                       the same fact. `summary`, when
 *                                       present, is the manager's OWN best text for the turn's
 *                                       outcome — the Codex manager supplies the completed
 *                                       agentMessage text it already has on hand (see
 *                                       codex-manager.ts's settleTurn), since the generic
 *                                       Claude-ring walk (SessionService.lastAssistantTextPublic)
 *                                       returns nothing or stale backfilled text on Codex. The
 *                                       Claude manager never sets it — the listener falls back
 *                                       to that ring walk, which IS reliable for Claude.
 *   'scheduled'(terminalId, activity) — turn ended by a wake-scheduler tool
 *   'needs-help'(terminalId, detail)  — turn ended needing the human (declared or inferred);
 *                                       detail: { ask: string; summary: string; inferred: boolean }
 *   'busy'   (terminalId)             — a turn started (idempotent while active)
 *   'failed' (terminalId)             — transport/request failure ended active work
 *   'resolved'(terminalId)            — a pending permission was answered
 *   'permission-cleared'(terminalId)  — a pending permission went away (answered, cancelled by the
 *                                       CLI, or stale at a turn end). Viewers drop their card. Never
 *                                       routed to status: it is not a new request (see adapter.ts).
 *   'exit'   (terminalId, code)       — the backing process/connection exited
 *   'message-source'(terminalId, src) — a tagged turn's result landed (persist src)
 *
 * The full list, with the argument types of each event, is StructuredManagerEvents
 * (shared/events.ts). `on`, `once`, `off` and `emit` below give a listener those types; the plain
 * EventEmitter signature stays as the second overload, so a listener with its own annotation
 * still compiles.
 */
export interface IStructuredManager extends EventEmitter {
  on<K extends StructuredManagerEventName>(event: K, listener: StructuredListener<K>): this;
  on(event: string | symbol, listener: AnyStructuredListener): this;
  once<K extends StructuredManagerEventName>(event: K, listener: StructuredListener<K>): this;
  once(event: string | symbol, listener: AnyStructuredListener): this;
  off<K extends StructuredManagerEventName>(event: K, listener: StructuredListener<K>): this;
  off(event: string | symbol, listener: AnyStructuredListener): this;
  emit<K extends StructuredManagerEventName>(event: K, ...args: StructuredManagerEvents[K]): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the plain EventEmitter signature
  emit(event: string | symbol, ...args: any[]): boolean;
  /**
   * True when a deny `message` reaches the model as the question's own tool result, so a chat
   * reply can answer a pending AskUserQuestion (see SessionService.answerPermission's `reply`).
   * Only the Claude manager does today. Codex drops a deny's message, and Grok/OpenCode are
   * untested, so a reply there falls back to a normal send.
   */
  readonly repliesToQuestions?: boolean;
  /**
   * The recorder of the message journal (W3-D), set by the daemon (journal/wire.ts). The manager gives
   * it the ring of each session it spawns; the structured socket asks it for the replay of a thread.
   * Absent: the manager writes no journal and the socket replays the ring.
   */
  journal?: JournalRecorder;
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
  /**
   * The complete texts the agent itself wrote in its last ENDED turn, oldest first, in full —
   * the one harness-independent way to read "what the agent just said" (the owner-decisions
   * capture uses it). Each harness reads them where they are complete: Claude from the whole
   * `assistant` messages in its ring (turnTextsFromEvents; a sub-agent's are left out), Codex
   * from each completed agentMessage item, Grok/OpenCode from each closed prose block. The ring
   * itself is not enough off Claude: it holds only streamed deltas there. null when this manager
   * has no live session for the terminal.
   */
  getTurnTexts(terminalId: string): string[] | null;
  /**
   * The model the live session REPORTED it runs (an init/bind response, a lead assistant frame,
   * or the answer to a switch), or undefined before any such frame. Never the saved
   * `config.model` alias: the service falls back to that itself (see SessionService.activeModel).
   */
  getModel?(terminalId: string): string | undefined;
  /**
   * Switch the live session to `model` for the next turn, keeping the conversation, by the
   * harness's own mechanism (see each manager). Resolves with the model id the harness reports
   * (or `model` when it reports none); rejects when the harness refuses it. On success it pushes
   * a `{type:'system', subtype:'model', model, switched:true}` notice into the ring and emits it.
   */
  setModel?(terminalId: string, model: string): Promise<string>;
  /**
   * Change the live session's reasoning effort from its next turn (Claude `apply_flag_settings`; Codex: sent with each
   * `turn/start`). Absent on Grok and OpenCode, which have no effort control in this phase. Rejects when the harness
   * refuses it, or with 'The thread stopped' when the thread ends before it answers (that is not a refusal).
   */
  setEffort?(terminalId: string, effort: string): Promise<void>;
  /** A line in the thread for a model/effort change the harness refused (kept in the replay ring). */
  postNotice?(terminalId: string, message: string): void;
  /**
   * Put one event the daemon wrote itself into the thread (kept in the replay ring and the journal, pushed
   * quiet): a `{type:'system', subtype:…}` notice such as `dispatch_notice` or `permission_blocked`.
   */
  postEvent?(terminalId: string, event: Record<string, unknown>): void;
  /** Switch the live thread between auto / ask / smart approvals (os/approvals.ts). */
  setApprovals?(terminalId: string, mode: Approvals): Promise<void>;
  /** The actions the harness blocked by itself and nobody answered yet (the in-thread cards). */
  getBlocked?(terminalId: string): BlockedAction[];
  /** "Allow this" / "Keep blocked" on a blocked action. False: no such action. */
  resolveBlocked?(terminalId: string, id: string, decision: 'allow' | 'keep'): Promise<boolean>;
  /** Codex: the efforts each model takes, from the app-server's last `model/list`, or null if never asked. */
  modelEfforts?(): Record<string, string[]> | null;
  /** Codex: the effort each model runs at by default (same source), or null if never asked. */
  modelDefaultEfforts?(): Record<string, string> | null;
  /** Codex: ask the app-server for them now (cached for a while). null when no app-server is running. */
  loadModelEfforts?(): Promise<Record<string, string[]> | null>;
  isAlive(terminalId: string): boolean;
  /**
   * Epoch ms of the last frame the live session's CLI put in the ring, or undefined when there is
   * no live session or no frame yet. The stall watchdog reads it (runtime/stall-watchdog.ts).
   * History seeded at spawn does not count: it is not a sign of life.
   * Optional in the type only because the test fakes of other suites do not have it; the three
   * real managers all implement it.
   */
  lastFrameAt?(terminalId: string): number | undefined;
  kill(terminalId: string): void;
  killAll(): void;
}

/**
 * The texts of the last ended turn in a Claude-shaped ring, oldest first: every whole
 * `assistant` text between the ring's last `result` and the `result` before it. Events with a
 * `parent_tool_use_id` belong to a sub-agent (a Task/Agent call) and never count as the agent's
 * own. A turn still running after the last `result` is not read.
 */
export function turnTextsFromEvents(events: readonly unknown[]): string[] {
  let end = events.length - 1;
  while (end >= 0 && (events[end] as any)?.type !== 'result') end--;
  const texts: string[] = [];
  for (let i = end - 1; i >= 0; i--) {
    const e: any = events[i];
    if (e?.type === 'result') break;
    if (e?.type !== 'assistant' || e.parent_tool_use_id != null || !Array.isArray(e.message?.content)) continue;
    const text = e.message.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join('').trim();
    if (text) texts.push(text);
  }
  return texts.reverse();
}

/** The input of the tool_use with this id in a Claude-shaped ring (newest first), or undefined. */
export function toolUseInput(events: readonly unknown[], toolUseId: unknown): unknown {
  if (typeof toolUseId !== 'string' || !toolUseId) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e: any = events[i];
    if (e?.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    const b = e.message.content.find((c: any) => c?.type === 'tool_use' && c.id === toolUseId);
    if (b) return b.input;
  }
  return undefined;
}

/** How much of a structured CLI's stderr to keep for its exit report. */
const STDERR_TAIL = 2000;
/** The longest wait after a CLI's 'exit' for its stdout and stderr to close (see spawn()). */
const EXIT_DRAIN_MS = 1000;
/** Claude's verdict on a `-r <id>` whose transcript is gone (Claude Code 2.1.296: an error
 *  `result` with no `result` field; the reason only in `errors[]` and on stderr). */
const CONVERSATION_LOST = /No conversation found with session ID: (\S+)/;

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
export class ClaudeStructuredSessionManager extends StructuredEmitter implements IStructuredManager {
  readonly repliesToQuestions = true;
  private sessions = new Map<string, Session>();
  private defaultEnv: Record<string, string> = {};
  /** The declared-status chain of a turn end (shared/settle-turn.ts). Claude's 'idle' has no summary. */
  private readonly settleDeps: SettleDeps = {
    idle: (terminalId, detail) => { this.fire('idle', terminalId, detail); },
    needsHelp: (terminalId, detail) => { this.fire('needs-help', terminalId, detail); },
    withSummary: false,
  };

  /** The message journal's recorder (W3-D). Set by the daemon; a manager with none writes no journal. */
  journal?: JournalRecorder;

  setDefaultEnv(env: Record<string, string>): void { this.defaultEnv = env; }

  spawn(terminalId: string, opts: StructuredSpawnOpts): number {
    if (this.sessions.has(terminalId)) this.kill(terminalId);
    const child = spawn(opts.command, opts.args, {
      cwd: opts.workDir,
      env: claudeChildEnv(this.defaultEnv, opts.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    child.stdin.on('error', () => {}); // Fix 2: suppress EPIPE if child closes stdin while alive

    const counterScope = randomUUID(); // Claude result counters restart with each CLI invocation.
    const rl = readline.createInterface({ input: child.stdout });
    const session: Session = { child, rl, ring: new EventRing(), compactor: new ClaudeStreamCompactor(), escalate: opts.escalate ?? false, toolPolicy: opts.toolPolicy, pending: null, accountId: opts.accountId, smart: opts.approvals === 'smart', blocked: [], mcpExpected: opts.mcpExpected ?? null, requestedModel: opts.model ?? null };
    // Resume backfill: seed the ring with prior history (restored from the claude
    // transcript) BEFORE any live event lands, so a ws (re)connect replays the past
    // conversation first and the View isn't blank after a daemon restart.
    if (opts.seedEvents?.length) session.ring.seed(opts.seedEvents);
    // W3-D: each finished item goes to the message journal. Claude sends each block again as a whole frame.
    const recorder = this.journal?.attach(terminalId, session.ring, { wholeFrames: true, seeds: opts.seedEvents });
    session.recorder = recorder;
    this.sessions.set(terminalId, session);
    child.stderr.on('data', (chunk: Buffer) => {
      // Redact the whole joined text, so a key split across two chunks is still found.
      session.stderrTail = redactKeys((session.stderrTail ?? '') + chunk.toString()).slice(-STDERR_TAIL);
    });
    rl.on('line', (line) => {
      if (this.sessions.get(terminalId) !== session) return;
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: any;
      try { event = JSON.parse(trimmed); } catch { return; } // skip non-JSON noise
      // Capture the claude session_id (carried on the init/system event, and echoed
      // on later events). Surface it via a 'session' emit so the spawner can persist
      // it onto the terminal's external_id and resume this conversation after a restart.
      const sid: unknown = event?.session_id;
      if (typeof sid === 'string' && sid && session.sessionId !== sid) {
        session.sessionId = sid;
        this.fire('session', terminalId, sid);
      }
      // The answer to one of OUR control requests (set_model): settle its promise. Not an
      // event for the chat, so it is not delivered below.
      if (event?.type === 'control_response') {
        const rid = event.response?.request_id;
        const waiter = typeof rid === 'string' ? session.controls?.get(rid) : undefined;
        if (waiter) {
          session.controls!.delete(rid);
          clearTimeout(waiter.timer);
          if (event.response?.subtype === 'error') waiter.reject(new Error(String(event.response?.error ?? 'The CLI refused the request')));
          else waiter.resolve(event.response?.response ?? {});
          return;
        }
      }
      session.ring.push(event, { size: trimmed.length });
      // Ring only: a message that is in the ring as whole frames loses its stream frames there.
      // The live 'event' emit below is not changed.
      session.compactor.observe(session.ring, event);
      // The active model: init carries it on every turn; a lead assistant frame carries what
      // answered. A sub-agent's frame (parent_tool_use_id) and a synthetic frame never count.
      if (event?.type === 'system' && event?.subtype === 'init' && typeof event.model === 'string' && event.model) session.model = event.model;
      if (event?.type === 'system' && event?.subtype === 'init' && !session.modelLogged) { session.modelLogged = true; logThreadModel(terminalId, 'claude-code', session.requestedModel ?? null, typeof event.model === 'string' ? event.model : null); }
      // Every init frame (Claude Code sends one each turn): a connector or server can load after the first.
      if (event?.type === 'system' && event?.subtype === 'init' && session.mcpExpected) this.checkMcpServers(terminalId, session, event);
      if (event?.type === 'assistant' && event?.parent_tool_use_id == null) {
        const m = event.message?.model;
        if (typeof m === 'string' && m && m !== SYNTHETIC) session.model = m;
      }
      if (session.smart) this.observeSmart(terminalId, session, event);
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
        const toolName = typeof r?.tool_name === 'string' ? r.tool_name : '';
        // Every thread first refuses a kill by name or pattern (see broad-kill-guard.ts), then
        // applies its own policy, if any.
        const denied = isAsk
          ? null
          : broadKillDenial(toolName, r?.input) ?? (session.toolPolicy ? session.toolPolicy(toolName, r?.input) : null);
        if (denied && !denied.allow) {
          // Policy deny: answer the CLI immediately with the instructive message — the model
          // sees it as the tool result and can redirect (spawn an agent) within the same turn.
          this.write(terminalId, {
            type: 'control_response',
            response: { subtype: 'success', request_id: event.request_id, response: { behavior: 'deny', message: denied.message } },
          });
        } else if (!isAsk && session.allowOnce?.known && sameToolCall(session.allowOnce, { toolName, input: r?.input })) {
          // The ONE call the person allowed ("Allow this", see allowOnce()): answered by the daemon, once.
          this.write(terminalId, {
            type: 'control_response',
            response: { subtype: 'success', request_id: event.request_id, response: { behavior: 'allow', updatedInput: r?.input } },
          });
          void this.endAllowOnce(terminalId, session);
        } else if (session.escalate || isAsk || session.smart || session.allowOnce) {
          // Smart approvals: auto mode let the routine calls run without asking, so EVERY request
          // that still arrives is one the classifier or an `ask` rule wants a person for.
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
          this.fire('permission', terminalId, pending);
        } else {
          // Auto-allow tool permission requests — parity with --dangerously-skip-permissions.
          this.write(terminalId, {
            type: 'control_response',
            response: { subtype: 'success', request_id: event.request_id, response: { behavior: 'allow', updatedInput: event.request.input } },
          });
        }
      }
      // The CLI dropped the request it was blocked on. Claude Code 2.1.296 sends this on an
      // interrupt while a question is up, in the same millisecond as the interrupt's reply.
      if (event?.type === 'control_cancel_request' && session.pending && event.request_id === session.pending.requestId) {
        this.clearPending(terminalId, session);
      }
      // A turn the CLI began on its own (no sendMessage): open it here, before its frames and
      // its `result` are delivered, so the status edge and the thread's report fire at its end.
      // Only the parent's own output starts a turn: a sub-agent's frames carry parent_tool_use_id,
      // and a stream_event other than message_start (a trailing stop) is never a start.
      const startsTurn = event?.parent_tool_use_id == null
        && (event?.type === 'assistant' || (event?.type === 'stream_event' && event?.event?.type === 'message_start'));
      if (!session.turnOpen && startsTurn) {
        session.turnOpen = true;
        this.fire('busy', terminalId);
      }
      // Deliver the final frame before settle listeners close analytics or start another turn.
      this.fire('event', terminalId, { ...event, telemetry: { counterScope } });
      // A signed-out or expired login: say so as a typed event right after the error frame, so the
      // chat shows a sign-in card instead of the raw error (auth/auth-failure.ts).
      const auth = authRequiredFrame(event, 'claude', session.accountId);
      if (auth) {
        session.ring.push(auth, { quiet: true });
        this.fire('event', terminalId, auth);
        this.fire('auth-required', terminalId, auth);
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
      // A usage limit shows in its own frame before the error `result` (the synthetic assistant
      // frame carries the structured reset time); remember it for the boundary below.
      // The account's current limit figures (Details panel); sent on every turn.
      if (event?.type === 'rate_limit_event') this.fire('rate-limit', terminalId, event.rate_limit_info ?? event.rateLimitInfo);
      if (event?.parent_tool_use_id == null && event?.type !== 'result') {
        const hit = detectClaudeLimit(event, Date.now());
        if (hit) session.limit = hit;
      }
      // The turn ended with the allowed call still unused, and nothing waits for the person: the window closes.
      // (The turn that was already running when the person allowed it ends first: that end does not count.)
      if (event?.type === 'result' && session.allowOnce && !session.pending) {
        if (session.allowOnce.skipResults > 0) session.allowOnce.skipResults--;
        else void this.endAllowOnce(terminalId, session);
      }
      if (event?.type === 'result') {
        session.turnOpen = false;
        // Backstop: a CLI blocked on a request cannot end a turn, so a pending still set here is
        // stale. Cleared before the settle emits below, so the status sees it while the turn is open.
        if (session.pending) this.clearPending(terminalId, session);
        const declared = session.declared;
        const wake = session.lastToolUse && WAKE_TOOLS.has(session.lastToolUse.name) ? session.lastToolUse : undefined;
        session.lastToolUse = undefined; // reset for the next turn
        session.declared = undefined;    // ditto — a declaration is per-turn

        const limit = event.is_error === true ? (session.limit ?? detectClaudeLimit(event, Date.now())) : undefined;
        session.limit = undefined;
        if (limit) {
          // A usage limit is a pause, not a failure: the thread shows as dormant until it resets,
          // and the limit service parks it and wakes it (limits/service.ts).
          this.fire('scheduled', terminalId, pauseLabel(limit.kind, limit.resetsAt, Date.now(), undefined, 30 * 60_000));
          this.fire('usage-limit', terminalId, limit);
        } else if (event.is_error === true) {
          // A resume of a conversation Claude no longer has. Name the id, so the service stops
          // reviving it with the same doomed `-r` (#76).
          const lost = Array.isArray(event.errors)
            ? event.errors.map((e: unknown) => (typeof e === 'string' ? CONVERSATION_LOST.exec(e)?.[1] : undefined)).find(Boolean)
            : undefined;
          if (lost) this.fire('conversation-lost', terminalId, lost);
          this.fire('failed', terminalId);
        } else if (wake && declared?.state !== 'needs_you') {
          // A pending timer is an observable FACT; a declaration of done or blocked is only a
          // CLAIM, and it can contradict the fact — e.g. the agent calls ScheduleWakeup and also
          // declares 'done' in the same turn. When they disagree, the fact wins: the thread isn't
          // finished, it has a wake pending and will run again, so this must not settle (or
          // notify a coordinator) as idle. Only a declared needs_you wins over a wake: a
          // question blocks the thread regardless of a pending timer.
          this.fire('scheduled', terminalId, wakeActivity(wake.name, wake.input));
        } else {
          // The shared declared-status chain (shared/settle-turn.ts): a declared needs_you →
          // 'needs-help'; a declared done or blocked → 'idle' with its state (`blocked` settles
          // idle on purpose: a thread that waits on another agent still proceeds without the
          // human); nothing declared → the closing text decides. Claude's part of it is that
          // text: read from the ring ONCE, and only when nothing was declared (the walk is not
          // free). A question there is marked inferred, so it renders as a guess and the
          // false-positive rate stays measurable.
          const text = declared ? '' : this.lastAssistantText(terminalId);
          settleTurn(
            { terminalId, declared },
            !declared && looksLikeQuestion(text) ? { kind: 'needs-help', ask: text, summary: text } : { kind: 'idle' },
            this.settleDeps,
          );
        }

        // The turn that just ended is now fully flushed to the transcript (result is always
        // the LAST thing the CLI writes for a turn) — so if it was sent with a source tag,
        // this is the earliest safe moment to resolve it to a real disk uuid (see
        // sessions/service.ts's 'message-source' listener, which does the disk read + persist).
        if (session.pendingSource) this.fire('message-source', terminalId, session.pendingSource);
        session.pendingSource = undefined;
      }
    });

    // Node can fire 'exit' before the child's stdout and stderr are drained, and the last frame
    // (a failed resume's only reason, #76) must still be read. So finish once both streams have
    // closed, or EXIT_DRAIN_MS after 'exit' if something else holds them open.
    let exitCode: number | null = null;
    let finished = false;
    let open = 2; // stdout (via readline) + stderr
    const finish = () => {
      if (finished || exitCode === null) return;
      finished = true;
      // Fix 1: only clear the map if this child is still the current session
      // (a re-spawn may have already replaced it; its exit must not evict the new child)
      if (this.sessions.get(terminalId)?.child !== child) return;
      recorder?.close(); // W3-D: a block that streamed when the CLI exited is written
      session.pending = null; // drop any unanswered permission — the process is gone
      for (const c of session.controls?.values() ?? []) { clearTimeout(c.timer); c.reject(new Error('The thread stopped')); }
      session.controls?.clear();
      this.sessions.delete(terminalId);
      const detail = redactKeys(session.stderrTail?.trim() ?? '') || undefined;
      // The daemon log is the only place this reaches when no browser is watching.
      if (exitCode && detail) console.error(`[structured] thread ${terminalId} exited (${exitCode}): ${detail}`);
      this.fire('exit', terminalId, exitCode, detail);
    };
    const streamClosed = () => { if (--open === 0) finish(); };
    rl.on('close', streamClosed);
    child.stderr.on('close', streamClosed);
    child.on('exit', (code) => {
      exitCode = code ?? 0;
      session.exitCode = exitCode; // no longer alive: a send now starts a new process
      if (open === 0) finish();
      else setTimeout(finish, EXIT_DRAIN_MS).unref();
    });
    child.on('error', (err) => {
      if (this.sessions.get(terminalId)?.child !== child) return;
      this.fire('event', terminalId, { type: 'system', subtype: 'spawn_error', message: redactKeys(String(err)) });
      this.fire('failed', terminalId);
    });

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
    // SENT_MARK: a sent message, never classified as harness context (journal/recorder.ts).
    const ev: { type: 'user'; message: { role: 'user'; content: ContentBlock[] }; meta?: { source: MessageSource }; [SENT_MARK]: true } =
      { type: 'user', message: { role: 'user', content: echoContent }, [SENT_MARK]: true };
    if (source) ev.meta = { source };
    const s = this.sessions.get(terminalId);
    if (s) {
      s.ring.push(ev, { quiet: true });
      // Always overwritten (even to undefined for an untagged send) so a stale tag from a
      // prior turn can never leak onto this one's `result` resolution.
      s.pendingSource = source;
    }
    this.fire('event', terminalId, ev);
    // Turn start: delivering a message kicks off work → the thread is busy.
    if (s) s.turnOpen = true;
    this.fire('busy', terminalId);
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
    this.clearPending(terminalId, s);
    return true;
  }

  /**
   * Drop the pending request and tell everyone. 'resolved' returns the status to working;
   * 'permission-cleared' makes every viewer drop its card, even one that never sees a tool_result
   * for it (a cancel, or a stale pending at a turn end).
   */
  private clearPending(terminalId: string, s: Session): void {
    s.pending = null;
    this.fire('resolved', terminalId);
    this.fire('permission-cleared', terminalId);
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
      this.clearPending(terminalId, s);
    }
    return true;
  }

  /**
   * Gracefully interrupt the current turn WITHOUT killing the process: send the
   * stream-json `interrupt` control on the same stdin channel the CLI uses for
   * control_responses. Mirrors how the CLI frames its own control_requests
   * (top-level `request_id` + `request.subtype`). The conversation stays alive and
   * can be steered/resumed afterwards. Returns false when there's no live session.
   * A pending question needs nothing extra: the CLI answers the interrupt even while blocked,
   * and sends a control_cancel_request for the pending request, which clears it (see spawn()).
   */
  interrupt(terminalId: string): boolean {
    const s = this.sessions.get(terminalId);
    if (!s || !s.child.stdin.writable) return false;
    const requestId = `interrupt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.write(terminalId, { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } });
    return true;
  }

  getModel(terminalId: string): string | undefined { return this.sessions.get(terminalId)?.model; }

  /**
   * Switch the running CLI's model with the stream-json `set_model` control request — the same
   * one the Agent SDK's `setModel` sends. Live-verified on Claude Code 2.1.319: the CLI answers
   * `{subtype:'success', response:{model:'claude-haiku-5-5'}}` (the alias resolved) and the next
   * turn's init and assistant frames carry the new model; the conversation is kept.
   */
  setModel(terminalId: string, model: string): Promise<string> {
    const s = this.sessions.get(terminalId);
    return this.control(terminalId, { subtype: 'set_model', model }, 'model switch').then((r) => {
      const resolved = typeof r?.model === 'string' && r.model ? r.model : model;
      if (!s || this.sessions.get(terminalId) !== s) return resolved;
      s.model = resolved;
      const notice = { type: 'system', subtype: 'model', model: resolved, switched: true };
      s.ring.push(notice, { quiet: true });
      this.fire('event', terminalId, notice);
      return resolved;
    });
  }

  /**
   * Change the running CLI's reasoning effort for this session with `apply_flag_settings {effortLevel}`
   * (live-verified on Claude Code 2.1.316: no model call, nothing written to the user's settings.json, and
   * it survives later `set_model` calls). The CLI silently ignores a level it does not know, so the caller
   * checks the level first.
   */
  async setEffort(terminalId: string, effort: string): Promise<void> {
    await this.control(terminalId, { subtype: 'apply_flag_settings', settings: { effortLevel: effort } }, 'effort change');
  }

  /** A line in the thread for the viewers and the replay: a model/effort change the CLI refused. */
  /**
   * The init-frame check of a hosted Claude Code thread (os/hosted-mcp-policy.ts), on EVERY init frame.
   * One `thread.mcp` line on the first frame and on a frame with something new. A warning (the
   * `thread.mcp.unexpected` line, the console, and a notice in the thread that the journal keeps) for:
   * a server Dispatch did not pass, an Artifact tool, an MCP tool of a server Dispatch did not pass,
   * and a frame with no server list. Each name is reported once per process.
   */
  private checkMcpServers(terminalId: string, session: Session, event: unknown): void {
    const NO_LIST_KEY = '(no server list)'; // in `mcpWarned`: the no-list warning was given
    const expected = session.mcpExpected ?? [];
    const seen = (session.mcpWarned ??= new Set<string>());
    const first = !session.mcpChecked;
    session.mcpChecked = true;
    const list = initServerNames(event);
    const reported = list ?? [];
    const tools = [...forbiddenInitTools(event), ...unexpectedInitMcpTools(expected, event)];
    const all = [...unexpectedServers(expected, reported), ...tools];
    const extra = all.filter((n) => !seen.has(n));
    const noList = list === null && !seen.has(NO_LIST_KEY);
    if (first || extra.length || noList) {
      boxLog('thread.mcp', { thread: terminalId, harness: 'claude-code', servers: list ?? null, expected: [...expected], unexpected: all });
    }
    if (noList) {
      seen.add(NO_LIST_KEY);
      boxLog('thread.mcp.unexpected', { thread: terminalId, harness: 'claude-code', reason: 'no server list in the init frame' }, 'warn');
      console.warn(`[mcp] WARNING thread ${terminalId}: the init frame has no server list; the servers could not be checked`);
      this.postEvent(terminalId, { type: 'system', subtype: 'dispatch_notice', level: 'warning', message: NO_SERVER_LIST_NOTICE });
    }
    if (extra.length === 0) return;
    for (const n of extra) seen.add(n);
    const newTools = tools.filter((t) => extra.includes(t));
    boxLog('thread.mcp.unexpected', { thread: terminalId, harness: 'claude-code', unexpected: extra, ...(newTools.length ? { tools: newTools } : {}) }, 'warn');
    console.warn(`[mcp] WARNING thread ${terminalId}: the harness loaded MCP servers or tools Dispatch did not pass: ${extra.join(', ')}`);
    this.postEvent(terminalId, { type: 'system', subtype: 'dispatch_notice', level: 'warning', message: unexpectedServersNotice(extra) });
  }

  postEvent(terminalId: string, event: Record<string, unknown>): void {
    const s = this.sessions.get(terminalId);
    if (!s) return;
    s.ring.push(event, { quiet: true });
    this.fire('event', terminalId, event);
  }

  /**
   * Smart approvals, per CLI frame (measured on Claude Code 2.1.322, 2026-11-11):
   *  - `system/permission_denied` (decision_reason_type classifier): auto mode refused a call and
   *    told only the model. It becomes a card: what, why, Allow this / Keep blocked.
   *  - `system/init` or `system/status` naming a permissionMode other than `auto`: the model has no
   *    auto mode and the CLI fell back silently. Escalate every tool instead, with one plain line.
   */
  private observeSmart(terminalId: string, session: Session, event: any): void {
    if (event?.type !== 'system') return;
    if (event.subtype === 'permission_denied') {
      const toolName = typeof event.tool_name === 'string' ? event.tool_name : 'tool';
      // The event names the call, not its input: find the input in the call's own tool_use frame.
      const input = event.tool_input ?? event.input ?? toolUseInput(session.ring.snapshot(), event.tool_use_id);
      const b: BlockedAction = {
        id: typeof event.tool_use_id === 'string' && event.tool_use_id ? event.tool_use_id : randomUUID(),
        toolName, title: approvalTitle(toolName, input), detail: inputDetail(input),
        reason: typeof event.decision_reason === 'string' ? event.decision_reason : typeof event.message === 'string' ? event.message : null,
        at: Date.now(),
      };
      session.blocked = [...(session.blocked ?? []).filter((x) => x.id !== b.id), b].slice(-20);
      (session.blockedInputs ??= new Map()).set(b.id, input);
      for (const id of session.blockedInputs.keys()) if (!session.blocked.some((x) => x.id === id)) session.blockedInputs.delete(id);
      this.postEvent(terminalId, blockedEvent(b));
      return;
    }
    // While one allowed call is awaited the CLI is in its asking mode on purpose: that is not a fallback.
    const counts = !session.smartSwitching && !session.allowOnce && (event.subtype === 'status' || (event.subtype === 'init' && !session.smartLive));
    const mode = counts ? event.permissionMode ?? event.permission_mode : undefined;
    if (typeof mode === 'string' && mode && mode !== 'auto' && !session.smartFallback) this.fallBackFromSmart(terminalId, session);
  }

  private fallBackFromSmart(terminalId: string, session: Session): void {
    session.smartFallback = true;
    session.escalate = true;
    this.postEvent(terminalId, { type: 'system', subtype: 'dispatch_notice', level: 'info', message: SMART_FALLBACK_NOTICE });
  }

  async setApprovals(terminalId: string, mode: Approvals): Promise<void> {
    const s = this.sessions.get(terminalId);
    if (!s) throw new Error('This thread is not running');
    if (mode === 'smart') {
      s.smart = true;
      s.smartLive = true;
      s.smartFallback = false;
      s.escalate = false;
      s.smartSwitching = true;
      try {
        await this.control(terminalId, { subtype: 'set_permission_mode', mode: 'auto' }, 'approval change');
      } catch {
        // `auto_mode_model`: this model has no auto mode. Ask for every tool instead.
        this.fallBackFromSmart(terminalId, s);
      } finally {
        s.smartSwitching = false;
      }
      return;
    }
    if (s.smart) await this.control(terminalId, { subtype: 'set_permission_mode', mode: 'default' }, 'approval change').catch(() => undefined);
    s.smart = false;
    s.smartFallback = false;
    this.setEscalate(terminalId, mode === 'ask');
  }

  getBlocked(terminalId: string): BlockedAction[] {
    return [...(this.sessions.get(terminalId)?.blocked ?? [])];
  }

  async resolveBlocked(terminalId: string, id: string, decision: 'allow' | 'keep'): Promise<boolean> {
    const s = this.sessions.get(terminalId);
    const b = s?.blocked?.find((x) => x.id === id);
    if (!s || !b) return false;
    s.blocked = s.blocked!.filter((x) => x.id !== id);
    const known = s.blockedInputs?.has(id) ?? false;
    const input = s.blockedInputs?.get(id);
    s.blockedInputs?.delete(id);
    this.postEvent(terminalId, blockedResolvedEvent(id, decision));
    if (decision === 'allow') await this.allowOnce(terminalId, s, b, known && input !== undefined, input);
    return true;
  }

  /**
   * "Allow this", as a signal the model cannot write (os/approvals.ts). The words of a message never
   * allow anything here. The daemon:
   *   1. remembers the ONE call the person allowed (tool and exact input);
   *   2. puts the CLI in its asking mode with a control request (`set_permission_mode default`), so the
   *      harness's own judgement of the conversation text is out of the path and the retry arrives at the
   *      daemon as a `can_use_tool` request;
   *   3. tells the model, in a plain line, to run the call again;
   *   4. answers `allow` to a request for exactly that call (see the membrane in spawn()); every other
   *      gated call in that window waits for the person, like any approval card;
   *   5. goes back to the smart mode when the call was answered, the turn ended, or the time ran out.
   * Only this method arms it, and only the owner's `POST …/blocked/:id` reaches this method.
   */
  private async allowOnce(terminalId: string, s: Session, b: BlockedAction, known: boolean, input: unknown): Promise<void> {
    if (s.allowOnce) clearTimeout(s.allowOnce.timer);
    const timer = setTimeout(() => { void this.endAllowOnce(terminalId, s); }, ALLOW_ONCE_MS);
    timer.unref?.();
    s.allowOnce = { toolName: b.toolName, input, known, timer, skipResults: s.turnOpen ? 1 : 0 };
    // Already asking for every tool (a model with no smart mode): nothing to switch.
    if (!s.smartFallback) {
      try {
        await this.control(terminalId, { subtype: 'set_permission_mode', mode: 'default' }, 'approval');
      } catch {
        // The CLI did not leave its own mode: no call can be allowed for the person. Say so; allow nothing.
        clearTimeout(timer);
        s.allowOnce = null;
        this.postEvent(terminalId, { type: 'system', subtype: 'dispatch_notice', level: 'warning', message: 'Dispatch could not allow that action. Ask for it again: you will be asked before it runs.' });
        return;
      }
    }
    this.sendMessage(terminalId, allowedOnceMessage(b));
  }

  /** The one allowed call was used, or its window closed: back to the smart mode. */
  private async endAllowOnce(terminalId: string, s: Session): Promise<void> {
    const held = s.allowOnce;
    if (!held) return;
    clearTimeout(held.timer);
    s.allowOnce = null;
    if (this.sessions.get(terminalId) !== s || !s.smart || s.smartFallback) return;
    s.smartSwitching = true;
    try {
      await this.control(terminalId, { subtype: 'set_permission_mode', mode: 'auto' }, 'approval');
    } catch {
      // The smart mode did not come back: ask for every tool instead (the safe side), with the one plain line.
      this.fallBackFromSmart(terminalId, s);
    } finally {
      s.smartSwitching = false;
    }
  }

  postNotice(terminalId: string, message: string): void {
    const s = this.sessions.get(terminalId);
    if (!s) return;
    const ev = { type: 'system', subtype: 'settings_refused', message };
    s.ring.push(ev, { quiet: true });
    this.fire('event', terminalId, ev);
  }

  /** One of our own control requests, answered through `controls` (see the control_response branch in spawn()). */
  private control(terminalId: string, request: Record<string, unknown>, what: string): Promise<any> {
    const s = this.sessions.get(terminalId);
    if (!s || s.exitCode !== undefined || !s.child.stdin.writable) return Promise.reject(new Error('This thread is not running'));
    const requestId = `ctl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    s.controls ??= new Map();
    const answer = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { s.controls?.delete(requestId); reject(new Error(`The CLI did not answer the ${what} in time. It may still take it: check the model and effort shown.`)); }, CONTROL_TIMEOUT_MS);
      s.controls!.set(requestId, { resolve, reject, timer });
    });
    this.write(terminalId, { type: 'control_request', request_id: requestId, request });
    return answer;
  }

  kill(terminalId: string): void {
    const s = this.sessions.get(terminalId);
    if (!s) return;
    for (const c of s.controls?.values() ?? []) { clearTimeout(c.timer); c.reject(new Error('The thread stopped')); }
    if (s.allowOnce) { clearTimeout(s.allowOnce.timer); s.allowOnce = null; }
    s.controls?.clear();
    s.pending = null;
    // Remove the session first: closing readline below can finish a pending drain (see spawn()),
    // which must then find the session gone and stay silent — this is the one 'exit'.
    this.sessions.delete(terminalId);
    s.rl.close(); // Fix 3: close readline so buffered lines stop emitting after kill
    s.recorder?.close(); // W3-D: a block that streams at a stop (of the thread, of the daemon) is written
    killWithGrace(s.child); // SIGTERM, then SIGKILL if the CLI ignores it
    // A CLI that had already exited (still draining) reports its own code, not the kill's 0.
    this.fire('exit', terminalId, s.exitCode ?? 0, s.exitCode !== undefined ? redactKeys(s.stderrTail?.trim() ?? '') || undefined : undefined);
  }

  killAll(): void { for (const id of [...this.sessions.keys()]) this.kill(id); }

  isAlive(terminalId: string): boolean {
    const s = this.sessions.get(terminalId);
    return !!s && s.exitCode === undefined; // a CLI that exited is not alive while its streams drain
  }

  /** The claude session_id captured for a live thread (from its init event), or undefined. */
  getSessionId(terminalId: string): string | undefined { return this.sessions.get(terminalId)?.sessionId; }

  lastFrameAt(terminalId: string): number | undefined { return this.sessions.get(terminalId)?.ring.lastPushAt; }

  getEvents(terminalId: string): unknown[] { return this.sessions.get(terminalId)?.ring.snapshot() ?? []; } // a copy

  /** The last ended turn's own texts (IStructuredManager.getTurnTexts): Claude writes them whole into the ring. */
  getTurnTexts(terminalId: string): string[] | null {
    const session = this.sessions.get(terminalId);
    return session ? turnTextsFromEvents(session.ring.view()) : null;
  }

  /**
   * The most recent assistant text in this session's event ring — what the turn ended
   * on. Mirrors SessionService.lastAssistantText, which reads the same ring from outside.
   */
  private lastAssistantText(terminalId: string, max = 2000): string {
    const events = this.sessions.get(terminalId)?.ring.view() ?? [];
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
    return this.sessions.get(terminalId)?.ring.tail(n) ?? [];
  }
}

/**
 * Back-compat alias: the class was renamed to `ClaudeStructuredSessionManager`
 * when `IStructuredManager` was extracted (a second manager, `CodexStructured…`,
 * satisfies the same interface). Existing importers of the old name keep working.
 */
export { ClaudeStructuredSessionManager as StructuredSessionManager };
