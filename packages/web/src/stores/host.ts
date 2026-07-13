import { create } from 'zustand';
import { api } from '../api/client';

interface HostState {
  platform: string | null;
  /** True only when the browser and the daemon are the same machine (and it's macOS). */
  canReveal: boolean;
  load: () => Promise<void>;
}

export const useHost = create<HostState>((set) => ({
  platform: null,
  canReveal: false,
  load: async () => {
    try {
      const h = await api.getHost();
      set({ platform: h.platform, canReveal: h.canReveal });
    } catch {
      // Probe failed — fail closed by explicit reset. Never offer an action we can't confirm
      // the daemon can perform. This is deliberate: if we ever had a stale "capable" state,
      // a failed probe must drive us back to incapable, not leave us in a broken state.
      set({ platform: null, canReveal: false });
    }
  },
}));
