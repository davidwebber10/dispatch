import type { SessionStatus } from '../types.js';

/**
 * The single rule for rolling per-terminal statuses up into one session status.
 *
 * Highest-attention wins: a thread blocked on the user (`needs_input`) outranks
 * an actively-working one, which outranks a stale `error`, which outranks idle
 * (`waiting`). Empty / unknown terminal statuses count as `waiting`.
 *
 * This is the ONLY place session aggregation precedence is defined — every
 * writer (StatusService, the pty-timing loop, the PTY-exit handler) calls here
 * so the project-level status can't disagree with itself.
 */
export function aggregateSessionStatus(terminalStatuses: string[]): SessionStatus {
  if (terminalStatuses.includes('needs_input')) return 'needs_input';
  if (terminalStatuses.includes('working')) return 'working';
  if (terminalStatuses.includes('error')) return 'error';
  return 'waiting';
}
