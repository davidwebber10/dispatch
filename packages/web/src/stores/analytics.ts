import { create } from 'zustand';
import type { ServerEvent } from '../api/events-socket';

/**
 * The analytics feed: a revision counter, nothing more.
 *
 * The daemon broadcasts `{ type: 'analytics-dirty' }` every time it closes a turn
 * (`server.ts:126`). The single socket in `App.tsx` fans that out to this store,
 * exactly as it does for projects, tabs and agents. An open Analytics page reads
 * `rev` and re-fetches when it changes — so the page follows the work as it
 * happens, with no polling.
 *
 * The counter deliberately carries no payload. The view owns the filters, so only
 * the view can know which queries to re-issue; a store that tried to hold the data
 * would have to duplicate that state. Bumping a number also means the view
 * RE-FETCHES rather than remounts, so the reader's filter selections survive every
 * turn that closes anywhere in Dispatch.
 */
interface AnalyticsFeedState {
  rev: number;
  /**
   * The open coalescing window, or null when none is open. Held in the store
   * rather than a module-scope variable so a test can reset it with setState.
   */
  pending: ReturnType<typeof setTimeout> | null;
  applyEvent: (e: ServerEvent) => void;
}

/**
 * How long to hold events before bumping the revision.
 *
 * The daemon broadcasts on EVERY closed turn, and each open page answers a
 * revision bump with eleven requests. A burst of agents settling together
 * therefore produced a burst of fetch storms. A few hundred milliseconds folds
 * that burst into one refresh and is far below the threshold at which a human
 * notices the page is behind.
 */
export const COALESCE_MS = 250;

export const useAnalyticsFeed = create<AnalyticsFeedState>((set, get) => ({
  rev: 0,
  pending: null,
  applyEvent: (e) => {
    if (e.type !== 'analytics-dirty') return;
    /*
     * This is a COALESCING window, not a polling timer, and the difference is the
     * whole point: the timer is armed only by an event that already arrived, and
     * it disarms itself when it fires. When no event arrives, nothing is
     * scheduled and `rev` never moves — so an idle page issues no requests at
     * all, exactly as it did before. A polling timer would keep firing forever.
     */
    if (get().pending) return; // a window is already open — fold this event into it
    const pending = setTimeout(() => {
      set({ pending: null, rev: get().rev + 1 });
    }, COALESCE_MS);
    set({ pending });
  },
}));
