import type { EventsSocket } from '../api/events-socket';
import { reconnectStructuredSockets } from '../api/structured-socket';
import { reconnectTerminalSockets } from '../api/terminal-socket';

/** How long a resume waits for the daemon's pong. 1.5 s was too short for a phone that wakes on a
 *  cellular link: the radio alone can need 2 to 3 s, and a missed pong cost a full reload of every view. */
export const RESUME_ALIVE_TIMEOUT_MS = 4000;

/**
 * The app came back to the foreground (W2-I). Ask the daemon whether the connection is alive.
 * - Alive: nothing changes.
 * - Dead: replace the events socket and every thread socket. The views are NOT remounted (the
 *   reconnect generation is not bumped): each chat keeps its items until its replay arrives, and
 *   each terminal resets and replays through its socket's own onReset.
 * `stillCurrent` returns false when the app replaced the events socket while the check was open.
 */
export async function resumeSockets(sock: EventsSocket, stillCurrent: () => boolean = () => true): Promise<'alive' | 'reconnected' | 'stale'> {
  const alive = await sock.checkAlive(RESUME_ALIVE_TIMEOUT_MS);
  if (alive) return 'alive';
  if (!stillCurrent()) return 'stale';
  sock.reconnect();
  reconnectStructuredSockets();
  reconnectTerminalSockets();
  return 'reconnected';
}
