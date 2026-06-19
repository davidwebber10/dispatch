export type TerminalType = 'claude-code' | 'codex' | 'shell' | 'browser' | 'notes' | 'file';
export type SessionStatus = 'working' | 'waiting' | 'needs_input' | 'done';
export type TerminalStatus = 'working' | 'waiting' | 'needs_input' | 'error';

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
  pid: number | null;
  externalId: string | null;
  workingDir: string | null;
  status: TerminalStatus;
  createdAt: string;
  config: Record<string, unknown>;
  archivedAt: string | null;
  sortOrder: number;
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
  createdAt: string;
  updatedAt: string;
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
