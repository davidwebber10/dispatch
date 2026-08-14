import { create } from 'zustand';
import type { ServerEvent } from '../api/events-socket';

/**
 * The analytics feed: a revision counter, nothing more.
 *
 * The daemon broadcasts `{ type: 'analytics-dirty' }` every time it closes a turn
 * (`server.ts:126`). The single socket in `App.tsx` fans that out to this store,
 * exactly as it does for projects, tabs and agents. An open Analytics page reads
 * `rev` and re-fetches when it changes — so the page follows the work as it
 * happens, with no polling timer anywhere.
 *
 * The counter deliberately carries no payload. The view owns the filters, so only
 * the view can know which queries to re-issue; a store that tried to hold the data
 * would have to duplicate that state. Bumping a number also means the view
 * RE-FETCHES rather than remounts, so the reader's filter selections survive every
 * turn that closes anywhere in Dispatch.
 */
interface AnalyticsFeedState {
  rev: number;
  applyEvent: (e: ServerEvent) => void;
}

export const useAnalyticsFeed = create<AnalyticsFeedState>((set, get) => ({
  rev: 0,
  applyEvent: (e) => { if (e.type === 'analytics-dirty') set({ rev: get().rev + 1 }); },
}));
