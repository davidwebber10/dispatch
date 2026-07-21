import { useThreadStatus } from '../stores/threadStatus';
import { useProjects } from '../stores/projects';
import { useTabs } from '../stores/tabs';

/**
 * Reconcile board/live state after the events socket reconnects.
 *
 * The live-status store (`useThreadStatus`) is a write-only overlay of
 * `terminal:status` broadcasts — there is no snapshot on connect and no replay of
 * what we missed. While the socket was down (iOS suspends it in the background, a
 * network blip, a laptop asleep) we can miss a thread's working→settled edge. The
 * daemon still settles the persisted row to `waiting`, but our in-memory overlay
 * stays frozen at `working`, and `boardColumn` trusts the live overlay over the
 * row — so a finished thread is pinned in the active/Working column until a full
 * reload wipes the overlay.
 *
 * So on every reconnect we do exactly what a reload does, without the reload: drop
 * the overlay and re-pull the authoritative rows. Fresh events then layer back on
 * top. A genuinely-working thread's refetched row is still `working`, so this never
 * mis-files an active thread as done.
 */
export async function resyncAfterReconnect(): Promise<void> {
  useThreadStatus.getState().reset();
  const ids = useProjects.getState().sessions.map((s) => s.id);
  await Promise.all(
    ids.map((id) => useTabs.getState().loadTabs(id).catch(() => { /* project gone — skip it */ })),
  );
}
