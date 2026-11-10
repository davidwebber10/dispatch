import type { Creator } from '../lib/creator';

export type TerminalType = 'claude-code' | 'codex' | 'grok' | 'opencode' | 'shell' | 'browser' | 'notes' | 'file';
export type SessionStatus = 'working' | 'waiting' | 'needs_input' | 'done';
// The backend genuinely persists AND broadcasts 'scheduled' (a wake-scheduler tool ended the
// turn — see structured/manager.ts's WAKE_TOOLS) and 'queued' (accepted but not yet launched —
// createQueuedTerminal) alongside the original four. `terminals.status` is a free-form TEXT
// column with no CHECK constraint, so these round-trip fine; this type just used to lag reality.
export type TerminalStatus = 'working' | 'waiting' | 'needs_input' | 'error' | 'scheduled' | 'queued';

export interface Session {
  id: string;
  provider: 'claude-code' | 'codex';
  name: string;
  notes: string;
  status: SessionStatus;
  workingDir: string;
  tags: string[];
  pid: number | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  archivedAt: string | null;
}

export interface Terminal {
  id: string;
  sessionId: string;
  type: TerminalType;
  label: string;
  /** Set by the daemon since v2.2.0. Absent on older daemons — treat as 'user'. */
  labelSource?: 'user' | 'default' | 'auto';
  pid: number | null;
  externalId: string | null;
  workingDir: string | null;
  status: TerminalStatus;
  createdAt: string;
  lastActivityAt?: string;
  config: Record<string, unknown>;
  archivedAt: string | null;
  sortOrder: number;
}

/**
 * How the last turn ended, stamped by the daemon on turn-end — declared via the
 * `report_status` tool, or inferred by the turn-end question heuristic when nothing was
 * declared (see docs/superpowers/specs/2026-07-20-thread-board-design.md, Phase 1). Rides in
 * `Terminal.config.lastOutcome`; absent entirely on a terminal that has never finished a turn —
 * that absence is itself meaningful (no evidence of finishing), not a default to paper over.
 * Parse it through `readLastOutcome` (components/board/boardColumn.ts) rather than casting
 * `t.config.lastOutcome` inline.
 *
 * `declaredState`/`blocker` were added by core commits 61b7730/dee6a4a and are both optional so
 * an old row (written before they existed) simply lacks them:
 *   declaredState?: 'done' | 'blocked' — WHICH state the agent declared for a non-needs-help
 *                              turn. Absent when undeclared (inferred: true) or when this was a
 *                              needs-help outcome. An absent declaredState must be treated as
 *                              "not blocked" — the safe default that covers every pre-existing
 *                              row, not an error to paper over.
 *   blocker?: string          — the agent's own text for what it's waiting on, present only
 *                              alongside `declaredState === 'blocked'`, and only when the agent
 *                              supplied text (an empty blocker omits the key entirely).
 */
export interface TerminalLastOutcome {
  summary: string;
  needsHelp: boolean;
  inferred: boolean;
  declaredState?: 'done' | 'blocked';
  blocker?: string;
  at: string;
}

/**
 * Board-only state: whether the human has acknowledged a finished thread, and any manual
 * correction of its derived column. Rides in `Terminal.config.boardState`; absent on every
 * terminal the board hasn't touched yet (or that predates it), which must behave as "not
 * acknowledged, no override" — never as an error. `override` deliberately excludes 'working':
 * the other three are judgements the human may make, but working is an observed fact (see the
 * spec's "Manual override" section). Real activity clears an active override server-side
 * (status/service.ts's `apply`), so the client only ever needs to honour whatever is on the row.
 * Parse it through `readBoardState` (components/board/boardColumn.ts) rather than casting
 * `t.config.boardState` inline.
 */
export interface TerminalBoardState {
  acknowledgedAt?: string;
  override?: 'needs_help' | 'complete' | 'resting' | null;
}

export interface Provider { name: string; displayName: string; }

export interface FileEntry { name: string; isDirectory: boolean; path: string; size?: number | null; }

export interface GitChangedFile { path: string; status: string }
export interface GitStatus { branch: string | null; files: GitChangedFile[] }

export interface AuthRequest {
  id: string;
  url: string;
  source: string;
  terminalId: string | null;
  cwd: string | null;
  status: 'pending' | 'opened' | 'callback_forwarded' | 'completed' | 'error';
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One release's human-readable notes, as written in docs/releases/vX.Y.Z.md. */
export interface ReleaseNote {
  /** The git tag, e.g. `v2.11.0`. */
  version: string;
  url: string;
  publishedAt: string;
  /** Markdown. */
  notes: string;
  /** The GitHub account that published the release. Absent when unknown. */
  author?: string;
  authorAvatarUrl?: string;
}

export interface UpdateState {
  available: boolean;
  version: string | null;
  url: string | null;
  publishedAt: string | null;
  currentVersion: string;
  /** Notes for every version between the running one and the newest, newest first. */
  notes?: ReleaseNote[];
  /** The note for the version running right now, for "what's new" in Settings. */
  currentNotes?: string | null;
}

export interface SessionStats {
  found: boolean;
  model?: string;
  totalTokens?: number;
  estimatedCostUSD?: number | null;
  messageCount?: number;
}

export interface InboxUpload { ok: true; path: string; absolutePath: string; }

export type ScheduleKind = 'one-shot' | 'recurring';
export type AgentRunStatus = 'queued' | 'starting' | 'working' | 'needs_input' | 'idle' | 'succeeded' | 'failed' | 'cancelled';

export interface AgentSchedule {
  id: string;
  projectId: string;
  name: string;
  provider: 'claude-code' | 'codex';
  workingDir: string;
  prompt: string;
  scheduleKind: ScheduleKind;
  runAt: string | null;
  recurrenceRule: string | null;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  defaultTerminalLabel: string | null;
  /** Who created it; null for a schedule from before the record existed. */
  createdBy?: Creator | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRun {
  id: string;
  scheduleId: string;
  projectId: string;
  terminalId: string | null;
  provider: 'claude-code' | 'codex';
  promptSnapshot: string;
  status: AgentRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  externalSessionId: string | null;
  lastOpenedAt: string | null;
  unreadSince: string | null;
  costUsd: number | null;
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  model: string | null;
  numTurns: number | null;
  resultText: string | null;
  transcriptPath: string | null;
  exitCode: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface TodoItem {
  content: string;
  status: string; // 'pending' | 'in_progress' | 'completed'
  activeForm?: string;
}

export type RunStepKind =
  | 'init' | 'assistant-text' | 'thinking' | 'tool-use' | 'tool-result' | 'todos' | 'usage' | 'result';

/** A single item in a run's activity stream (mirrors core RunStep). */
export interface RunStep {
  kind: RunStepKind;
  title: string;
  detail?: string;
  todos?: TodoItem[];
  status?: 'ok' | 'error';
  timeline: boolean;
  ts?: string;
}

export interface ConvItem {
  // 'notice' — a system-injected event that is structurally a `user` turn but is not the
  // human speaking (today: Claude Code's background-task completions, see
  // lib/taskNotification.ts). Rendered as a muted inline row inside the assistant's column,
  // never as a right-aligned user bubble. `text` holds the human-readable summary only.
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'tool-result' | 'result' | 'system' | 'image' | 'notice';
  text?: string;
  // image (kind 'image') — a rendered picture in the timeline. `imageUrl` is either an
  // inline data-URI (base64 source) or an http(s)/byte-route URL (path/file source).
  imageUrl?: string;
  imageAlt?: string;
  imageMime?: string;
  // True when this image rode in on the HUMAN's own `user` turn (an attachment they sent),
  // vs. an agent/tool-emitted or coordinator-posted picture. Lets a surface (e.g. the
  // Overseer stream) attribute it to "You" instead of the assistant. Undefined ⇒ not-user.
  imageFromUser?: boolean;
  // Who actually sent this turn (kind 'user' only): the human directly, or the coordinator
  // acting on their behalf (spawn_agent / message_agent). Undefined ⇒ untagged/legacy —
  // render exactly like 'user' (mirrors the imageFromUser default-false-like fallback).
  source?: 'user' | 'coordinator';
  toolName?: string;
  toolTitle?: string;
  toolDetail?: string;
  toolId?: string;    // tool_use id, for pairing tool ↔ tool-result across interleaving
  // The per-block key a streamed block was first rendered under (`s-<turn>-<index>`), kept when
  // its `uuid` is upgraded to the message's real uuid. Per-block UI state (an open thought) keys
  // off it, so the upgrade — which changes `uuid` for every block of the message at once — does
  // not reset what the reader opened (2026-11-06).
  blockKey?: string;
  isError?: boolean;
  // kind 'system' only: which daemon line it is. 'model' — the Pretty model switcher changed the
  // model; `text` holds the new model id (rendered with its friendly name).
  systemKind?: 'model';
  ts?: string;
  uuid?: string;
  // The sequence of the item in the daemon's message journal (W3-D): the item's identity in the thread.
  // Two items with the same `seq` are the same item. Absent on an item from before the journal (a
  // transcript page), on a block that still streams and on a line this client added itself.
  seq?: number;
  line?: number;      // source JSONL line index (enables jump-to from search)
  toolInput?: string; // tool call's raw arguments (for the Input tab)
  toolFile?: string;  // file path argument (for output-language inference)
  // result (stream-json `result` event) — the turn's outcome footer
  costUsd?: number;
  turns?: number;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
  level?: 'info' | 'error'; // for 'system' markers
  // kind 'user' only (W2-I): a bubble this client added when the owner pressed Send, before the
  // daemon's echo. `localId` names the send (every text block of one send shares it); the echo with
  // the same text replaces the item and both fields go. `sendState`: 'sending' while the POST is
  // open, 'failed' when it was refused (the bubble then offers Retry), absent once it was accepted.
  localId?: string;
  sendState?: 'sending' | 'failed';
}

export interface Conversation {
  items: ConvItem[];
  cursor: number;      // total line count (bottom edge for polling)
  startLine: number;   // top edge of the returned window
  hasMore: boolean;    // older lines exist above the window
  unsupported?: boolean;
}

/** One AskUserQuestion prompt inside a pending escalation. */
export interface PermissionQuestion {
  question: string;
  header?: string;
  options?: Array<string | { label?: string; name?: string; description?: string }>;
  multiSelect?: boolean;
}

/**
 * The gated tool / question a structured AGENT thread is blocked on (the membrane).
 * `questions` is present for AskUserQuestion; otherwise it's a plain gated tool whose
 * arguments live in `input`.
 */
export interface PendingPermission {
  requestId: string;
  toolName: string;
  input?: Record<string, unknown>;
  toolUseId?: string;
  questions?: PermissionQuestion[];
}

export interface SearchMatch {
  line: number;        // source JSONL line index (jump target)
  kind: string;
  snippet: string;
}

export interface CreateScheduleInput {
  projectId: string;
  name: string;
  provider: 'claude-code' | 'codex';
  workingDir: string;
  prompt: string;
  scheduleKind: ScheduleKind;
  runAt: string | null;
  recurrenceRule: string | null;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  defaultTerminalLabel: string | null;
}

// Cross-project agent overview (GET /api/agents/overview) — mirrors core.
export interface AgentOverviewAgent {
  scheduleId: string;
  name: string;
  provider: string;
  enabled: boolean;
  nextRunAt: string | null;
  spendUsd: number;
  runCount: number;
  lastRunAt: string | null;
  running: boolean;
}
export interface AgentOverviewProject {
  projectId: string;
  projectName: string | null;
  spendUsd: number;
  runningCount: number;
  agents: AgentOverviewAgent[];
}
export interface AgentOverview {
  totalSpendUsd: number;
  totalRuns: number;
  runningCount: number;
  agentCount: number;
  projects: AgentOverviewProject[];
}

// Recent Claude Code sessions (resume picker) — mirrors core /api/sessions/:id/cc-recent.
export interface CcRecentSession { id: string; mtime: number; preview: string; messageCount: number; truncated: boolean; }
export interface CodexRecentSession { id: string; mtime: number; preview: string; messageCount: number; truncated: boolean; }

// Setup / onboarding — mirrors core /api/setup.
export type ProviderName = 'claude' | 'codex' | 'grok' | 'opencode';
export interface ProviderStatus { name: ProviderName; installed: boolean; version?: string; signedIn: boolean | 'unknown'; }
/** Result of POST /api/setup/install/:provider — the re-detected truth, not the exit code. */
export interface InstallResult { ok: boolean; output: string; status: ProviderStatus; loginCommand: string; }
export interface TailscaleStatus { installed: boolean; running: boolean; dnsName?: string; url?: string; }
export interface SetupState { firstRun: boolean; providers: ProviderStatus[]; tailscale: TailscaleStatus; secrets: { connected: boolean }; }

// Harness settings — mirrors core /api/settings/harnesses. The opencode KEY itself never
// crosses this wire: `opencodeKey` carries the Doppler secret NAME and a presence boolean.
/** One entry of the OpenCode picker list: an OpenCode-namespaced OpenRouter id plus its label. */
export interface OpencodeModel { label: string; model: string }
/** Claude's working words (core settings/harness-settings.ts SpinnerVerbs): 'replace' shows only these, 'append' adds them. */
export interface SpinnerVerbs { mode: 'append' | 'replace'; verbs: string[] }
/** One of your own named word sets (core SpinnerSet). */
export interface SpinnerSet { name: string; words: string[] }
export interface HarnessSettingsEntry { defaultModel?: string; defaultMode?: 'cli' | 'pretty'; keySecret?: string; models?: OpencodeModel[]; skipAgentSummaries?: boolean; autoArchiveMs?: number; spinnerVerbs?: SpinnerVerbs; spinnerSets?: SpinnerSet[] }
export interface HarnessSettingsResponse {
  settings: Partial<Record<string, HarnessSettingsEntry>>;
  opencodeKey: { secret: string; present: boolean };
  /** The EFFECTIVE OpenCode picker list: the user's, else the daemon's curated defaults. */
  opencodeModels: OpencodeModel[];
  overseerWorkers?: { byType: Record<string, { harness?: string; model?: string }> };
}
/** A row of OpenRouter's catalog, as served by GET /api/settings/harnesses/opencode/catalog. */
export interface OpencodeCatalogEntry {
  id: string; label: string; name: string; contextLength: number | null; created: number; alias: boolean; aliasTarget?: string;
  /** False when no endpoint accepts a tool list: the thread runs chat-only (no shell, files, or peer tools). */
  tools?: boolean;
}

// Secrets (Doppler) — mirrors core /api/secrets.
/** Which threads get DOPPLER_TOKEN in their environment: every thread, or only a thread the owner turned on (config.secretsEnv). */
export type DopplerTokenScope = 'all' | 'opted-in';
/** `tokenScope` is absent from a daemon older than v4.5.0; that reads as 'all'. */
export interface DopplerStatus { connected: boolean; project: string | null; config: string | null; enabled: boolean; readOnly: boolean; tokenScope?: DopplerTokenScope }
export interface DopplerSecret { name: string }
export interface DopplerProject { id: string; slug: string; name: string }
export interface DopplerConfig { name: string; environment: string }

/** `authState` 'unknown' = the sign-in check gave no answer (e.g. timed out). Older daemons send only `authed`. */
export interface ToolStatus { name: string; description: string; kind: 'binary' | 'npm' | 'script'; installed: boolean; version?: string; authed: boolean; authState?: 'ok' | 'needed' | 'unknown'; docs?: string }
/** GET /api/tools. `checkedAt` is when the CLI auth checks last ran (null until the first run). */
export interface ToolsResponse { tools: ToolStatus[]; checkedAt: string | null }

export interface Integration { id: string; name: string; type: 'stdio' | 'remote'; command: string | null; args: string[]; url: string | null; headers: Record<string, string>; env: Record<string, string>; enabled: boolean; createdAt: string; updatedAt: string; createdBy?: Creator | null }
export type AddIntegrationInput =
  | { type: 'remote'; name: string; url: string; headers?: Record<string, string>; env?: Record<string, string> }
  | { type: 'stdio'; name: string; command: string; args?: string[]; env?: Record<string, string> };
export interface IntegrationsExport { version: 1; integrations: Omit<Integration, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'>[] }

// Analytics (usage, throughput, personal stats) — mirrors core packages/core/src/analytics/queries.ts
// and packages/core/src/routes/analytics.ts.
export interface AnalyticsRange { from?: string; to?: string; projectId?: string; provider?: string }
export type AnalyticsMetric = 'tokens' | 'outputTokens' | 'turns' | 'duration';
export type AnalyticsGroupBy = 'model' | 'provider' | 'project' | 'outcome' | 'none';
export type AnalyticsDimension = 'project' | 'thread' | 'model';

export interface AnalyticsSummary {
  turns: number;
  threads: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  totalTokens: number;
  /**
   * Turns that closed without a single usage-bearing frame ever being seen.
   *
   * This is NOT the same as a turn that used zero tokens. A Codex turn can settle
   * through its error path without ever emitting a usage frame, and a PTY thread emits
   * no frames at all. Those turns really did consume tokens; we simply never got a
   * count. Never render this as a measured zero — show it separately, e.g. "N turns
   * reported no usage".
   */
  unreportedTurns: number;
  /** Estimated API list-price value only; provider-reported dollars are separate. */
  apiValueUsd: number;
  reportedCostUsd?: number | null;
  coverage?: { reported: number; partial: number; missing: number; unsupported: number };
  pricingVersion?: string;
  /** True when usage or list-price coverage is incomplete. */
  valueIsPartial: boolean;
}

export interface AnalyticsPoint { day: string; key: string; value: number }
export interface AnalyticsTopRow { key: string; label: string; value: number }

export interface AnalyticsRecords {
  totalTokens: number;
  totalTurns: number;
  busiestDay: string | null;
  busiestDayTokens: number;
  topModel: string | null;
  activeDays: number;
  longestTurnSeconds: number;
}

/** When analytics recording began. Live recording only — the history importer is gone. */
export interface AnalyticsTracking {
  trackingStartedAt: string;
}

// Control Plane analytics. The payload type lives in core, in a file with no imports, so the
// daemon and the client share one definition.
export type {
  AgentSeriesKey, ControlPlaneAnalytics, ControlPlaneMissionRow, ControlPlaneProjectRow,
  ControlPlaneSummary, ControlPlaneTypeRow, MissionStatus,
} from '../../../core/src/analytics/control-plane-types';

// The pinned card (pinned card spec 2026-10-08): the decision ledger of one project, as the daemon
// computes it. The payload type lives in core, in a file with no imports, as above.
export type {
  CardItem, CardKind, CardOption, CardOrigin, CardSource, CardSourceKind, CardStatus, LedgerCard, LedgerSource,
} from '../../../core/src/overseer/ledger-card-types';

// Endless Chat (spec 2026-10-13). `media` holds image file names served by /api/endless/media/:name.
export type EndlessKind = 'user' | 'unii' | 'tool' | 'echo' | 'work' | 'note';
export interface EndlessMessage { i: number; kind: EndlessKind; text: string; size: number; project: string | null; projectName: string | null; ref: string | null; media: string[]; createdAt: number }
export interface EndlessPage { messages: EndlessMessage[]; hasMore: boolean; hasMoreAfter: boolean }
export type EndlessTurnStatus = 'idle' | 'waiting' | 'running' | 'failed' | 'interrupted';
/** Chat's one model and effort. null = the default; `defaultModel` is what null runs. */
export interface ChatSettings { model: string | null; effort: string | null; defaultModel: string }
export interface EndlessState { turn: { status: EndlessTurnStatus; error: string | null }; total: number; compactor: { unbuilt: number; merges: number; running: number } }
export interface EndlessSearchHit { i: number; kind: EndlessKind; project: string | null; projectName: string | null; createdAt: number; snippet: string }
export interface EndlessViewLine { name: string; l: number; i: number; text: string | null }
export interface EndlessView { lines: EndlessViewLine[]; bytes: number; rendered: string }
export interface EndlessProject { id: string; name: string; folder: string; live: number; needsYou: number; openItems: number; lastReport: string | null; messages: number }
export type EndlessPaneState = 'working' | 'needs_you' | 'queued' | 'error' | 'done' | 'idle';
export interface EndlessPaneThread { id: string; project: string; label: string; harness: string; state: EndlessPaneState; startedBy: 'chat' | 'overseer' | 'thread' | 'role' | 'user'; via: string | null; startedAt: string; lastActivityAt: string | null; question: string | null }
export interface EndlessProjectsResponse { projects: EndlessProject[]; threads: EndlessPaneThread[]; truncated: boolean }
export interface EndlessImage { media_type: string; data: string }
/** A document attached to a Chat message (PDF, TXT, MD, CSV, JSON): saved by the daemon, named by path for the model. */
export interface EndlessFile { name: string; media_type: string; data: string }
/** GET /api/endless/doc: one copy of a spec or plan doc (core docs/resolve.ts DocCopy). `worktree` is the base name the chip shows; `worktreeRel` names the worktree. */
export interface EndlessDocCopy { project: string; path: string; absPath: string | null; source: 'main' | 'worktree' | 'branch'; worktree: string | null; worktreeRel: string | null; branch: string | null; remote: boolean; vsMain: 'same' | 'changed' | 'not_on_main' | 'unknown'; modifiedAt: string; status: string | null; note: string | null; markdown: string }
/** GET /api/endless/docs: one in-progress doc of a project (core docs/list.ts DocRow). */
export interface EndlessDocRow { path: string; name: string; status: string | null; source: 'worktree' | 'branch'; worktree: string | null; worktreeRel: string | null; branch: string | null; vsMain: 'changed' | 'not_on_main'; modifiedAt: string; copies: number; writer: { id: string; label: string } | null }
/** GET /api/update/progress — the updater's status file plus its output tail (core update/progress.ts). */
export type UpdateStepName = 'pull' | 'install' | 'build' | 'tools' | 'restart';
export interface UpdateProgress {
  state: 'idle' | 'running' | 'restarting' | 'failed' | 'done';
  step: UpdateStepName | null;
  steps: UpdateStepName[];
  skipped: UpdateStepName[];
  startedAt: string | null;
  stepStartedAt: string | null;
  error: string | null;
  version: string | null;
  finishedAt: string | null;
  log: string[];
}
/** GET/POST /api/claude-auth — the daemon's headless Claude login (`claude setup-token`). */
/** The device-code sign-in of an added Codex account (core auth/codex-login.ts); `idle` when none runs. */
export interface CodexLoginSession { accountId: string; status: 'idle' | 'starting' | 'awaiting_user' | 'complete' | 'error'; url: string | null; code: string | null; error: string | null; createdAt: string | null }
export interface ClaudeLoginSession { id: string; status: 'starting' | 'awaiting_code' | 'exchanging' | 'complete' | 'error'; url: string | null; error: string | null; createdAt: string }
/** One usage-limit window; `usedPercent` is null when the provider gave a reset time but no figure. */
/** The daemon's run-out estimate for a window (core limits/forecast.ts): the recent pace projected to 100%. */
export interface LimitForecast { runsOutAt: number | null; lastsUntilReset: boolean; basisHours: number }
export interface LimitWindow { usedPercent: number | null; resetsAt: number | null; forecast?: LimitForecast }
/** GET /api/usage-limits — the account's limit figures for a thread's provider, plus its pause. */
export interface ThreadUsageLimits {
  provider: string;
  supported: boolean;
  /** `windows` is keyed by the provider's limit type (`five_hour`, `seven_day`, `seven_day_overage_included`, ...). */
  snapshot: { asOf: number; plan?: string; windows: Record<string, LimitWindow> } | null;
  paused: { kind: 'session' | 'weekly' | 'usage'; resetsAt: number | null; capped: boolean } | null;
}

/** One provider in the usage gauge (#127): the current account's windows, percents as integers. */
/** Banked limit resets the account can spend (Codex's reset credits). */
export interface ResetCredit { id: string; expiresAt: number | null; title: string | null }
/** Soonest-expiring first; `available` can exceed the list (the backend caps it). */
export interface ResetCredits { available: number; nextExpiresAt: number | null; credits?: ResetCredit[] }
export interface UsageSummaryProvider {
  provider: string; plan?: string; asOf: number; windows: Record<string, LimitWindow>; resetCredits?: ResetCredits;
  /** The Dispatch account (multi-account spec 2026-11-06): `cli` for the CLI's own login. An older daemon sends none. */
  accountId?: string;
  /** The account's name, for the card and the ring. */
  label?: string;
  /** Extra usage this month in minor units (cents): spent, and the monthly cap when there is one (Claude). */
  spend?: { usedMinor: number; limitMinor: number | null; currency: string };
  /** A prepaid credit balance in the tool's own units (Codex). */
  creditBalance?: { balance: number; unlimited: boolean };
}
/** Threads of one provider stopped on a limit, for the paused banner. */
export interface UsagePausedGroup {
  provider: string;
  /** session | weekly | fable | opus | sonnet | usage */
  kind: string;
  earliestResetsAt: number | null;
  /** Paused and capped together; Chat's own park counts as one. */
  threads: number;
  capped: number;
  chat: boolean;
  firstTerminalId: string;
  firstSessionId: string | null;
  /** The earliest pause start. */
  episodeStartedAt: number;
  /** The newest pause start: this device's dismiss holds until a pause newer than it. Missing from an older daemon. */
  latestStartedAt?: number;
  /** When the limit stops holding the group back (latest reset; null while a reset was never read and the limit has not cleared, so the chip stays red). The chip is red only before it. Missing from an older daemon. */
  activeUntil?: number | null;
}
/** GET /api/usage-limits/summary and the `usage-limits` broadcast carry the same body. */
export interface UsageSummary {
  /** When the daemon built it (ms). Orders summaries only from a 3.12 to 3.17 daemon, which sends no `epoch`. Missing from an older daemon. */
  at?: number;
  /** The daemon instance that built it. A new one means the daemon restarted. Missing from an older daemon. */
  epoch?: string;
  /** Rises on every summary within one epoch. The store keeps the newest, so a slow GET never undoes a newer event. Missing from an older daemon. */
  rev?: number;
  warnPercent: number;
  /** The daemon-wide push switch. Missing from an older daemon. */
  pushOnWarn?: boolean;
  providers: UsageSummaryProvider[];
  paused: UsagePausedGroup[];
}
/** GET/PUT /api/settings/usage-limits: daemon-wide, every device sees the same values. */
export interface UsageLimitSettings { warnPercent: number; pushOnWarn: boolean }


/** Accounts per harness (multi-account spec 2026-11-06). `cli` is the CLI's own login on the daemon's computer. */
export type AccountProvider = 'claude' | 'codex';
/**
 * What a Claude account's sign-in can do for the usage figures (W1-H): `sign-in-needed` (a new sign-in
 * repairs it), `not-available` (it runs threads but may not read usage), `rate-limited` (the last
 * figures stay), `ok`. `lastOkAt`: when the usage read last worked (ms), or null.
 */
export type UsageAccessState = 'ok' | 'sign-in-needed' | 'not-available' | 'rate-limited';
export interface Account { id: string; label: string; email?: string; plan?: string; isCli: boolean; addedAt: string | null; signedIn?: boolean; threadCount?: number; usageAccess?: { state: UsageAccessState; lastOkAt: number | null } }
/** A thread pinned to an account (the delete notice lists them). */
export interface AccountThread { id: string; label: string; sessionId: string }
export interface AccountsView { claude: Account[]; codex: Account[]; defaults: Record<AccountProvider, string> }

/** Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md): one row of GET /api/plugins. */
export interface PluginInstall { marketplace: string; version: string; sha256: string; installedAt: string; commit?: string }
export interface WorkerStats {
  state: 'running' | 'backoff' | 'stopped' | 'crashed';
  pid: number | null;
  restarts: number;
  startedAt: string | null;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
  socket: string | null;
  queued: number;
}

/** Marketplaces, catalog, updates and skills (plugins slice 6; spec sections 7 and 8). */
export interface Marketplace { url: string; slug: string; name: string | null; description: string | null; trusted: boolean; addedAt: string; lastPulledAt: string | null; error: string | null }
export interface CatalogEntry { marketplace: string; kind: 'plugin' | 'skill'; id: string; name: string; version: string; description: string | null; dispatch?: string; sdk?: number; changelog: string | null; installed?: { version: string } }
export interface PluginUpdate { id: string; name: string; marketplace: string; from: string; to: string; changelog: string | null }
export interface MarketVersion { version: string; commit: string; date: string }
export interface SkillRow { id: string; name: string; version: string; description: string | null; harnesses: string[] | null; projects?: string[] | null; folder: string; install: { marketplace: string; version: string; commit: string; installedAt: string } | null; enabled: boolean; enabledHere?: boolean; text: string; error?: string }

export interface PluginRow {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  dispatch?: string;
  sdk?: number;
  web?: string;
  contributes?: { views?: { id: string; label: string; icon?: string }[]; settings?: { id: string; label: string }[]; menus?: { thread?: string[]; project?: string[] }; slots?: string[]; tools?: string[] };
  permissions?: string[];
  enabled: boolean;
  /** The newest mtime in the folder: the bundle's cache-busting version. */
  stamp: number;
  /** Set when the folder is not a loadable plugin. */
  error?: string;
  /** The marketplace install record; null for a local plugin. */
  install: PluginInstall | null;
  /** True while the plugin holds a live key (enabled and not broken). */
  keyed?: boolean;
  /** Served from the Dispatch checkout: updates with Dispatch, cannot be removed. */
  bundled?: boolean;
  /** A local folder with this id hides a bundled plugin of the same id. */
  shadowsBundled?: boolean;
  hooks?: { runs: number; failures: number; dropped: number };
  /** Model calls in the last `days` days (coach spec section 4.5); `costUsd` sums the known costs. */
  assist?: { calls: number; failed?: number; inputTokens: number; outputTokens: number; costUsd?: number; days?: number };
  /** The worker the manifest declares, and its live state while a supervisor runs (plugins slice 5). */
  worker?: { command: string; args: string[]; env: Record<string, string>; jobs: { id: string; cron: string }[] };
  workerStats?: WorkerStats;
  /** An installed plugin's update state (spec 7.2). */
  update?: { to: string; changelog: string | null };
  pinned?: string;
  autoUpdate?: boolean;
  marketplaceGone?: boolean;
}

/** A plugin's stored document (spec section 5); `writer` is set when a thread key wrote it. */
export interface PluginDocWriter { terminalId: string; sessionId: string; label: string | null }
export interface PluginDocMeta { key: string; writer: PluginDocWriter | null; updatedAt: string; bytes: number }
export interface PluginDoc extends PluginDocMeta { value: unknown }

/**
 * GET /api/terminals/:id/diagnostics (W2-G): what the daemon recorded about a thread and why the
 * thread is in its state. The fields after `events` are absent on a daemon older than W2-G.
 * Metadata only: no message body, no question text.
 */
export interface ThreadDiagnostics {
  lifecycle: Record<string, unknown> | null;
  captureFailure: { event_type: string; observed_at: string; occurrences: number; reason: string } | null;
  /** Newest first, at most 200. */
  events: { event_type: string; generation: string | null; turn_id: string | null; observed_at: string; status: string | null; disposition: string }[];
  status?: 'queued' | 'starting' | 'working' | 'needs_input' | 'idle' | 'done' | 'error' | 'scheduled';
  transport?: 'structured' | 'pty';
  turnOpen?: boolean | null;
  /** Null when the daemon could not read the process state. */
  process?: { alive: boolean; transport: 'structured' | 'pty' } | null;
  stall?: { stalledSince: string; lastFrameAt: string | null } | null;
  park?: { state: 'parked' | 'woken' | 'capped'; provider: string; kind: string; resetsAt: number | null; wakeAt: number; attempts: number; parkedAt: number } | null;
  pendingQuestion?: { source: 'live' | 'saved'; toolName: string | null; question: boolean; createdAt: string | null } | null;
  /** The last 20 rows of the delivery outbox to and from the thread. `direction` is seen from this thread. */
  deliveries?: { id: number; direction: 'to' | 'from'; peerId: string | null; peerLabel: string | null; kind: string; state: 'pending' | 'delivered' | 'dropped'; attempts: number; lastError: string | null; createdAt: string | null; deliveredAt: string | null }[];
  explanation?: { rule: string; headline: string; since: string | null; reasons: string[]; nextSteps: { label: string; action: 'reset-status' | 'restart' | 'open-usage' | 'none' }[] } | null;
}

/**
 * The status of one thread as the daemon last committed it (W3-C, one status authority): the
 * `system/status` frame of the structured socket and the answer of GET /api/terminals/:id/status.
 * `(generation, sequence)` orders the snapshots; a lower one than the last one seen is ignored.
 */
export interface StatusSnapshot {
  status: 'queued' | 'starting' | 'working' | 'needs_input' | 'idle' | 'done' | 'error' | 'scheduled';
  /** True while a turn is in flight. The chat shows "Working" from this. */
  turnOpen: boolean;
  generation: number;
  sequence: number;
  at: string;
  activity: string | null;
}

/**
 * One finished item of a thread in the daemon's message journal (W3-D). `payload` is the
 * Claude-shaped event of the item: the client folds it the way it folds a socket event.
 * `seq` is the journal sequence (per thread, never a repeat). It is not the status sequence.
 */
export interface JournalItem {
  seq: number;
  kind: 'user' | 'assistant' | 'tool' | 'result' | 'notice';
  at: string;
  payload: unknown;
  truncated?: true;
}

/** GET /api/terminals/:id/journal. `firstSeq`: the oldest sequence the journal has; older history is the transcript route's. */
export interface JournalPage {
  items: JournalItem[];
  firstSeq: number;
  lastSeq: number;
  hasMore: boolean;
}

/**
 * The first frame of a structured socket that replays from the journal (`?journal=1`).
 * `reset: true`: the newest window, it replaces the view. `reset: false`: the items after the
 * cursor the client sent (`?after=seq`); the view stays and they are added.
 */
export interface JournalFrame extends JournalPage {
  type: 'journal';
  reset: boolean;
  after: number | null;
}
