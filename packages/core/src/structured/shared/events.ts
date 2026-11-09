// packages/core/src/structured/shared/events.ts
//
// The events that a structured manager emits, with the arguments of each. One map for the three
// managers (Claude, Codex, ACP). A manager emits through `StructuredEmitter.fire`, which the
// compiler checks against the map; a listener on a name in the map gets its argument types.
//
// The plain EventEmitter signature stays as a second overload of `on`, `off`, `once` and `emit`.
// So a listener written before the map (sessions/service.ts, the test fakes) still compiles
// when its own annotation is wider or narrower than the map. Those listeners are not moved in
// this wave.

import { EventEmitter } from 'node:events';
import type { MessageSource, PendingPermission } from '../manager.js';
import type { UsageLimit } from '../../limits/detect.js';

/** How a turn that needs no human ended. See IStructuredManager's doc comment in manager.ts. */
export interface IdleDetail {
  /** True when the agent declared the outcome (report_status done or blocked). */
  declared: boolean;
  state?: 'done' | 'blocked';
  blocker?: string;
  /** The manager's own text for the outcome (Codex, ACP). Claude never sets it. */
  summary?: string;
}

/** A turn that ended on a question for the human, declared or guessed from the closing text. */
export interface NeedsHelpDetail {
  ask: string;
  summary: string;
  inferred: boolean;
}

/** What a Codex turn/start refused, and the model that the thread went back to. */
export interface SettingsRefusedInfo {
  model?: string;
  effort?: string;
  restoredModel?: string;
}

export interface StructuredManagerEvents {
  /**
   * A stream event for the chat (Claude-shaped JSON). The payload is `any`, as it was before the
   * map: the listeners written before it read the event's fields with no cast.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- an untyped wire payload; see above
  event: [terminalId: string, event: any];
  /** The external session or thread id to persist. */
  session: [terminalId: string, sessionId: string];
  /** A gated tool or a question waits for a decision. */
  permission: [terminalId: string, pending: PendingPermission];
  /** A pending permission went away (answered, cancelled, stale at a turn end). Claude only. */
  'permission-cleared': [terminalId: string];
  /** A pending permission was answered. */
  resolved: [terminalId: string];
  /** A turn ended and needs no human. */
  idle: [terminalId: string, detail: IdleDetail];
  /** A turn ended on a question for the human. */
  'needs-help': [terminalId: string, detail: NeedsHelpDetail];
  /** A turn ended asleep: a wake tool, or a usage limit pause. `activity` is the label. */
  scheduled: [terminalId: string, activity: string];
  /** A turn started. Codex adds the turn id. */
  busy: [terminalId: string, detail?: { turnId?: string }];
  /** A transport or request failure ended the work. */
  failed: [terminalId: string];
  /** The process or connection behind the thread ended. `detail` is the CLI's stderr tail (Claude). */
  exit: [terminalId: string, code: number, detail?: string];
  /** The result of a tagged turn landed: persist who sent it. Claude only. */
  'message-source': [terminalId: string, source: MessageSource];
  /** A turn stopped on a usage limit. */
  'usage-limit': [terminalId: string, limit: UsageLimit];
  /** The account's current limit figures (a Claude rate_limit_event). */
  'rate-limit': [terminalId: string, info: unknown];
  /** The login is signed out or expired; `frame` is the system/auth_required event. */
  'auth-required': [terminalId: string, frame: unknown];
  /** A resume named a conversation that Claude no longer has. */
  'conversation-lost': [terminalId: string, lostSessionId: string];
  /** The shared Codex app-server was started again; `pid` is the new process. */
  'process-restarted': [terminalId: string, pid: number];
  /** Codex refused a picked model or effort. */
  'settings-refused': [terminalId: string, info: SettingsRefusedInfo];
}

export type StructuredManagerEventName = keyof StructuredManagerEvents;

/** The names in the map, for a run-time check (events.test.ts keeps the two in step). */
export const STRUCTURED_MANAGER_EVENT_NAMES: readonly StructuredManagerEventName[] = [
  'event', 'session', 'permission', 'permission-cleared', 'resolved', 'idle', 'needs-help', 'scheduled', 'busy',
  'failed', 'exit', 'message-source', 'usage-limit', 'rate-limit', 'auth-required', 'conversation-lost',
  'process-restarted', 'settings-refused',
];

export type StructuredListener<K extends StructuredManagerEventName> = (...args: StructuredManagerEvents[K]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the plain EventEmitter signature
export type AnyStructuredListener = (...args: any[]) => void;

/**
 * The base class of the three managers: an EventEmitter whose own emits are checked against the map
 * (`fire`), and whose `on`, `once` and `off` give a listener the argument types of the map.
 */
export class StructuredEmitter extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0); // each chat viewer adds its own 'event' listener
  }

  /** Emit an event of the map. The managers emit only through this. */
  protected fire<K extends StructuredManagerEventName>(event: K, ...args: StructuredManagerEvents[K]): boolean {
    return this.emit(event, ...args);
  }

  override on<K extends StructuredManagerEventName>(event: K, listener: StructuredListener<K>): this;
  override on(event: string | symbol, listener: AnyStructuredListener): this;
  override on(event: string | symbol, listener: AnyStructuredListener): this { return super.on(event, listener); }

  override once<K extends StructuredManagerEventName>(event: K, listener: StructuredListener<K>): this;
  override once(event: string | symbol, listener: AnyStructuredListener): this;
  override once(event: string | symbol, listener: AnyStructuredListener): this { return super.once(event, listener); }

  override off<K extends StructuredManagerEventName>(event: K, listener: StructuredListener<K>): this;
  override off(event: string | symbol, listener: AnyStructuredListener): this;
  override off(event: string | symbol, listener: AnyStructuredListener): this { return super.off(event, listener); }
}
