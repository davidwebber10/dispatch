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
      // Probe failed — stay incapable. Reveal simply won't appear in the menu, which is the
      // correct degradation: never offer an action we can't confirm the daemon can perform.
    }
  },
}));
