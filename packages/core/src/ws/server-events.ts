/**
 * The events that the daemon sends on the `/api/events` WebSocket, as one discriminated union.
 *
 * Types only, with no imports, so the web client imports this file directly
 * (packages/web/src/api/server-events.ts re-exports it) and the two sides cannot drift.
 *
 * The members are the event types that a web store reads today. Each member lists the fields
 * that every sender in core sets. A field marked optional is absent from some senders or from an
 * older daemon. An object payload is `ServerEventPayload` here: this file has no imports, so the
 * reader gives it its real type (Session, Terminal, AgentRun and so on).
 *
 * The broadcaster (`ws/events.ts`) is still untyped. W3-A of the 2026-11-09 engineering program
 * types `broadcast()` with this union and adds the event shapes that are missing here.
 *
 * When you add a member, also add its required fields to `REQUIRED_FIELDS` in the web file. The
 * compiler refuses the web build until you do.
 */

export type ServerEventPayload = Record<string, unknown>;

// ── Threads (terminals) ──────────────────────────────────────────────────────
export type TerminalCreatedEvent = { type: 'terminal:created'; terminal: ServerEventPayload };
export type TerminalStatusEvent = {
  type: 'terminal:status';
  terminalId: string;
  /** The coarse terminal status (`working`, `waiting`, ...). */
  status: string;
  /** The declared thread status. Absent from the senders that only know the coarse status. */
  threadStatus?: string;
  /** Null clears the activity line; absent leaves it as it is. */
  activity?: string | null;
};
/** The stall watchdog (W1-D): a working thread with no output past the threshold; null clears the flag. */
export type TerminalStallEvent = { type: 'terminal:stall'; terminalId: string; stalledSince: string | null };
export type TerminalActivityEvent = {
  type: 'terminal:activity';
  terminalId: string;
  activity?: string | null;
  model?: string | null;
  context?: string | null;
  cost?: string | null;
  tokens?: string | null;
  percentage?: string | null;
  version?: string | null;
  sessionId?: string | null;
};
/**
 * `status` is never sent: an exit always reads as `waiting`. It is declared so that a reader which
 * handles `terminal:status` and `terminal:exit` in one branch can still read `e.status`.
 */
export type TerminalExitEvent = { type: 'terminal:exit'; terminalId: string; sessionId?: string; status?: undefined };
export type TerminalRemovedEvent = { type: 'terminal:removed'; terminalId: string; sessionId?: string };

// ── Projects (sessions) ──────────────────────────────────────────────────────
export type SessionCreatedEvent = { type: 'session:created'; session: ServerEventPayload };
export type SessionStatusEvent = { type: 'session:status'; sessionId: string; status: string; lastActivityAt?: string | null };
export type SessionArchivedEvent = { type: 'session:archived'; sessionId: string };
export type SessionUpdatedEvent = { type: 'session:updated'; sessionId: string };
export type SessionTabsChangedEvent = { type: 'session:tabs-changed'; sessionId: string };

// ── Agents (schedules and runs) ──────────────────────────────────────────────
export type AgentScheduleCreatedEvent = { type: 'agent:schedule-created'; schedule: ServerEventPayload };
export type AgentScheduleUpdatedEvent = { type: 'agent:schedule-updated'; schedule: ServerEventPayload };
export type AgentScheduleRemovedEvent = { type: 'agent:schedule-removed'; scheduleId: string };
export type AgentRunCreatedEvent = { type: 'agent:run-created'; run: ServerEventPayload };
export type AgentRunUpdatedEvent = { type: 'agent:run-updated'; run: ServerEventPayload };
export type AgentRunStepEvent = { type: 'agent:run-step'; runId: string; terminalId?: string; step: ServerEventPayload };

// ── Sign-in requests, updates, analytics, the ledger, usage ──────────────────
export type AuthRequestEvent = { type: 'auth:request'; request: ServerEventPayload };
export type AuthUpdatedEvent = { type: 'auth:updated'; request: ServerEventPayload };
export type UpdateAvailableEvent = { type: 'update:available'; version: string; url?: string | null; publishedAt?: string | null };
export type UpdateInProgressEvent = { type: 'update:in-progress' };
export type UpdateFailedEvent = { type: 'update:failed'; reason?: string };
export type AnalyticsDirtyEvent = { type: 'analytics-dirty' };
export type LedgerChangedEvent = { type: 'ledger:changed'; sessionId: string };
export type UsageLimitsEvent = {
  type: 'usage-limits';
  warnPercent: number;
  providers: unknown[];
  paused: unknown[];
  at?: number;
  epoch?: string;
  rev?: number;
  pushOnWarn?: boolean;
};

// ── Chat (the endless conversation) ──────────────────────────────────────────
export type EndlessMessageEvent = { type: 'endless:message'; message: ServerEventPayload };
export type EndlessDeltaEvent = { type: 'endless:delta'; kind: string; text: string };
export type EndlessSettingsEvent = { type: 'endless:settings'; model?: string | null; effort?: string | null; defaultModel?: string };
export type EndlessTurnEvent = { type: 'endless:turn'; status: string; error?: string };

// ── Plugins (the three that the app itself reads) ────────────────────────────
export type PluginChangedEvent = { type: 'plugin:changed'; id: string; plugin?: ServerEventPayload | null };
export type PluginDataEvent = { type: 'plugin:data'; id: string; key: string; deleted?: boolean };
export type PluginUpdatesEvent = { type: 'plugin:updates'; updates: unknown[] };

/** Every event type that the app itself reads. */
export type KnownServerEvent =
  | TerminalCreatedEvent | TerminalStatusEvent | TerminalActivityEvent | TerminalStallEvent | TerminalExitEvent | TerminalRemovedEvent
  | SessionCreatedEvent | SessionStatusEvent | SessionArchivedEvent | SessionUpdatedEvent | SessionTabsChangedEvent
  | AgentScheduleCreatedEvent | AgentScheduleUpdatedEvent | AgentScheduleRemovedEvent
  | AgentRunCreatedEvent | AgentRunUpdatedEvent | AgentRunStepEvent
  | AuthRequestEvent | AuthUpdatedEvent
  | UpdateAvailableEvent | UpdateInProgressEvent | UpdateFailedEvent
  | AnalyticsDirtyEvent | LedgerChangedEvent | UsageLimitsEvent
  | EndlessMessageEvent | EndlessDeltaEvent | EndlessSettingsEvent | EndlessTurnEvent
  | PluginChangedEvent | PluginDataEvent | PluginUpdatesEvent;

/**
 * Any other event: a plugin's own event, `thread:*`, or a type from a newer daemon. It is the
 * last member, so `e.type === '<known type>'` narrows to that member or to this one.
 */
export type UnknownServerEvent = { type: string; [k: string]: unknown };

export type ServerEvent = KnownServerEvent | UnknownServerEvent;

export type KnownServerEventType = KnownServerEvent['type'];

/** The member with this `type`: `EventOf<'terminal:status'>`. */
export type EventOf<T extends KnownServerEventType> = Extract<KnownServerEvent, { type: T }>;
