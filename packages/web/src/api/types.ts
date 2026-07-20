export type TerminalType = 'claude-code' | 'codex' | 'shell' | 'browser' | 'notes' | 'file';
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
 */
export interface TerminalLastOutcome {
  summary: string;
  needsHelp: boolean;
  inferred: boolean;
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

export interface FileEntry { name: string; isDirectory: boolean; path: string; }

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

export interface UpdateState {
  available: boolean;
  version: string | null;
  url: string | null;
  publishedAt: string | null;
  currentVersion: string;
}

export interface SessionStats {
  found: boolean;
  model?: string;
  totalTokens?: number;
  estimatedCostUSD?: number;
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
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'tool-result' | 'result' | 'system' | 'image';
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
  isError?: boolean;
  ts?: string;
  uuid?: string;
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
export interface ProviderStatus { name: 'claude' | 'codex'; installed: boolean; version?: string; signedIn: boolean | 'unknown'; }
export interface TailscaleStatus { installed: boolean; running: boolean; dnsName?: string; url?: string; }
export interface SetupState { firstRun: boolean; providers: ProviderStatus[]; tailscale: TailscaleStatus; secrets: { connected: boolean }; }

// Secrets (Doppler) — mirrors core /api/secrets.
export interface DopplerStatus { connected: boolean; project: string | null; config: string | null; enabled: boolean; readOnly: boolean }
export interface DopplerSecret { name: string; value: string }
export interface DopplerProject { id: string; slug: string; name: string }
export interface DopplerConfig { name: string; environment: string }

export interface ToolStatus { name: string; description: string; kind: 'binary' | 'npm' | 'script'; installed: boolean; version?: string; authed: boolean; docs?: string }

export interface Integration { id: string; name: string; type: 'stdio' | 'remote'; command: string | null; args: string[]; url: string | null; headers: Record<string, string>; env: Record<string, string>; enabled: boolean; createdAt: string; updatedAt: string }
export type AddIntegrationInput =
  | { type: 'remote'; name: string; url: string; headers?: Record<string, string>; env?: Record<string, string> }
  | { type: 'stdio'; name: string; command: string; args?: string[]; env?: Record<string, string> };
export interface IntegrationsExport { version: 1; integrations: Omit<Integration, 'id' | 'createdAt' | 'updatedAt'>[] }
