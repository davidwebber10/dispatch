import { create } from 'zustand';

/** The terminal the user is looking at RIGHT NOW (null when none — e.g. mobile
 *  thread list, dispatch tab, blurred app). Feeds presence reports so the server
 *  skips alerting only the device already watching the resolving thread. */
export const useViewing = create<{ id: string | null; set: (id: string | null) => void }>((set) => ({
  id: null,
  set: (id) => set({ id }),
}));
