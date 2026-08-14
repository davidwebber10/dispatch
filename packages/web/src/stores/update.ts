import { create } from 'zustand';
import { api } from '../api/client';
import type { ReleaseNote, UpdateState as UpdateStateDto } from '../api/types';
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
  /** Notes for every version between the one running and the newest, newest first. */
  notes: ReleaseNote[];
  /** The note for the version running right now (Settings shows it when up to date). */
  currentNotes: string | null;
  /** True once any client (this one or another) has triggered POST /api/update/apply. */
  inProgress: boolean;
  load: () => Promise<void>;
  /** Ask the server to poll GitHub right now (Settings → Check for updates). */
  check: () => Promise<void>;
  applyEvent: (e: ServerEvent) => void;
  dismiss: () => void;
}

function fromDto(state: UpdateStateDto): Partial<UpdateState> {
  return {
    available: state.available ? { version: state.version!, url: state.url, publishedAt: state.publishedAt } : null,
    currentVersion: state.currentVersion,
    notes: state.notes ?? [],
    currentNotes: state.currentNotes ?? null,
  };
}

export const useUpdate = create<UpdateState>((set, get) => ({
  available: null,
  currentVersion: null,
  dismissedVersion: null,
  notes: [],
  currentNotes: null,
  inProgress: false,
  load: async () => {
    set(fromDto(await api.getUpdateState()));
  },
  check: async () => {
    set(fromDto(await api.checkUpdate()));
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
      // The event stays small on purpose — release notes can run to tens of kilobytes,
      // and this broadcast reaches every connected client. Pull them over REST instead,
      // so a client that was already open still shows what the update contains.
      void get().load().catch(() => {});
    } else if (e.type === 'update:in-progress') {
      set({ inProgress: true });
    }
  },
  dismiss: () => set({ dismissedVersion: get().available?.version ?? null }),
}));
