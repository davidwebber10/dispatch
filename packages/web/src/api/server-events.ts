/**
 * The typed events of the `/api/events` WebSocket (engineering program 2026-11-09, W1-G).
 *
 * The union lives in core, in a file with no imports, so the daemon and the client share one
 * definition (the same arrangement as the analytics and ledger payload types in api/types.ts).
 * This file adds the one runtime part: `parseServerEvent`, the check at the socket.
 */
import type { KnownServerEventType, ServerEvent } from '../../../core/src/ws/server-events';

export type {
  EventOf, KnownServerEvent, KnownServerEventType, ServerEvent, ServerEventPayload, UnknownServerEvent,
} from '../../../core/src/ws/server-events';

/** `object` means a plain object: not null, not an array. */
type FieldKind = 'string' | 'number' | 'object' | 'array';

/**
 * The fields that a frame of a known type must carry, with their primitive kind. Only the
 * required fields are here: an optional field is not checked, so a frame from an older daemon
 * that lacks it still passes, and the stores keep their own `typeof` checks for those.
 * The `Record` over `KnownServerEventType` makes the compiler ask for a row for each new member.
 */
const REQUIRED_FIELDS: Record<KnownServerEventType, Record<string, FieldKind>> = {
  'terminal:created': { terminal: 'object' },
  'terminal:status': { terminalId: 'string', status: 'string' },
  'terminal:activity': { terminalId: 'string' },
  'terminal:stall': { terminalId: 'string' },
  'terminal:exit': { terminalId: 'string' },
  'terminal:removed': { terminalId: 'string' },
  'session:created': { session: 'object' },
  'session:status': { sessionId: 'string', status: 'string' },
  'session:archived': { sessionId: 'string' },
  'session:updated': { sessionId: 'string' },
  'session:tabs-changed': { sessionId: 'string' },
  'agent:schedule-created': { schedule: 'object' },
  'agent:schedule-updated': { schedule: 'object' },
  'agent:schedule-removed': { scheduleId: 'string' },
  'agent:run-created': { run: 'object' },
  'agent:run-updated': { run: 'object' },
  'agent:run-step': { runId: 'string', step: 'object' },
  'auth:request': { request: 'object' },
  'auth:updated': { request: 'object' },
  'update:available': { version: 'string' },
  'update:in-progress': {},
  'update:failed': {},
  'analytics-dirty': {},
  'ledger:changed': { sessionId: 'string' },
  'usage-limits': { warnPercent: 'number', providers: 'array', paused: 'array' },
  'endless:message': { message: 'object' },
  'endless:delta': { kind: 'string', text: 'string' },
  'endless:settings': {},
  'endless:turn': { status: 'string' },
  'plugin:changed': { id: 'string' },
  'plugin:data': { id: 'string', key: 'string' },
  'plugin:updates': { updates: 'array' },
};

function isKind(v: unknown, kind: FieldKind): boolean {
  if (kind === 'array') return Array.isArray(v);
  if (kind === 'object') return typeof v === 'object' && v !== null && !Array.isArray(v);
  return typeof v === kind;
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[events] ${message}`);
}

/** For tests: forget which types were already warned about. */
export function resetServerEventWarnings(): void { warned.clear(); }

/**
 * One frame of the events socket, checked. The JSON must be an object with a string `type`.
 * A frame of a known type must carry its required fields with the right primitive type. A frame
 * of any other type passes as it is (plugin events, `thread:*`, a newer daemon's events).
 * A bad frame returns null, with one `console.warn` per type for the life of the page.
 */
export function parseServerEvent(raw: string): ServerEvent | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { warnOnce('(not json)', 'dropped a frame that is not JSON'); return null; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) { warnOnce('(not an object)', 'dropped a frame that is not an object'); return null; }
  const o = v as Record<string, unknown>;
  if (typeof o.type !== 'string') { warnOnce('(no type)', 'dropped a frame with no string "type"'); return null; }
  const required = Object.prototype.hasOwnProperty.call(REQUIRED_FIELDS, o.type) ? REQUIRED_FIELDS[o.type as KnownServerEventType] : null;
  if (required) {
    for (const field of Object.keys(required)) {
      if (!isKind(o[field], required[field])) {
        warnOnce(o.type, `dropped a "${o.type}" frame: "${field}" must be ${required[field] === 'array' ? 'an array' : `a${required[field] === 'object' ? 'n' : ''} ${required[field]}`}`);
        return null;
      }
    }
  }
  return o as ServerEvent;
}
