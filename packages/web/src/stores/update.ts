import { create } from 'zustand';
import { api } from '../api/client';
import type { ServerEvent } from '../api/events-socket';

interface UpdateInfo {
  version: string;
  url: string | null;
  publishedAt: string | null;
}

interface UpdateState {
  available: UpdateInfo | null;
  currentVersion: string | null;
  dismissedVersion: string | null;
  /** True once any client (this one or another) has triggered POST /api/update/apply. */
  inProgress: boolean;
  load: () => Promise<void>;
  /** Ask the server to poll GitHub right now (Settings → Check for updates). */
  check: () => Promise<void>;
  applyEvent: (e: ServerEvent) => void;
  dismiss: () => void;
}

export const useUpdate = create<UpdateState>((set, get) => ({
  available: null,
  currentVersion: null,
  dismissedVersion: null,
  inProgress: false,
  load: async () => {
    const state = await api.getUpdateState();
    set({
      available: state.available ? { version: state.version!, url: state.url, publishedAt: state.publishedAt } : null,
      currentVersion: state.currentVersion,
    });
  },
  check: async () => {
    const state = await api.checkUpdate();
    set({
      available: state.available ? { version: state.version!, url: state.url, publishedAt: state.publishedAt } : null,
      currentVersion: state.currentVersion,
    });
  },
  applyEvent: (e) => {
    if (e.type === 'update:available' && typeof e.version === 'string') {
      set({
        available: {
          version: e.version,
          url: typeof e.url === 'string' ? e.url : null,
          publishedAt: typeof e.publishedAt === 'string' ? e.publishedAt : null,
        },
        inProgress: false,
      });
    } else if (e.type === 'update:in-progress') {
      set({ inProgress: true });
    }
  },
  dismiss: () => set({ dismissedVersion: get().available?.version ?? null }),
}));
