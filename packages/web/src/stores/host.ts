import { create } from 'zustand';
import { api } from '../api/client';

interface HostState {
  platform: string | null;
  flavor: 'macos' | 'wsl' | 'linux' | null;
  /** True only when the browser and the daemon are the same machine (with a native file manager). */
  canReveal: boolean;
  /** The daemon's platform-native file manager name (e.g. "Finder", "File Explorer"). */
  fileManagerName: string | null;
  load: () => Promise<void>;
}

export const useHost = create<HostState>((set) => ({
  platform: null,
  flavor: null,
  canReveal: false,
  fileManagerName: null,
  load: async () => {
    try {
      const h = await api.getHost();
      set({ platform: h.platform, flavor: h.flavor, canReveal: h.canReveal, fileManagerName: h.fileManagerName });
    } catch {
      // Probe failed — fail closed by explicit reset. Never offer an action we can't confirm
      // the daemon can perform. This is deliberate: if we ever had a stale "capable" state,
      // a failed probe must drive us back to incapable, not leave us in a broken state.
      set({ platform: null, flavor: null, canReveal: false, fileManagerName: null });
    }
  },
}));
