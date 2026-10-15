import { create } from 'zustand';
import { api } from '../api/client';
import type { ReleaseNote, UpdateProgress, UpdateState as UpdateStateDto } from '../api/types';
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
  failure: string | null;
  /** The updater's progress (polled by UpdateModal while an update runs). */
  progress: UpdateProgress | null;
  /** The last progress poll could not reach the daemon (it is restarting). */
  progressUnreachable: boolean;
  /** An update this client watched failed: the window shows the failure until Close. */
  runFailed: boolean;
  /** The user hid the window; a badge shows the update instead. */
  progressHidden: boolean;
  /** The update this client watched finished: the version it installed (the page has not reloaded yet). */
  doneVersion: string | null;
  /** When it finished (ms), for the reload after a quiet spell. */
  doneAt: number | null;
  /** The user chose Keep playing: the card hides, a small button reloads. */
  donePlaying: boolean;
  /** The update finished (from the progress file, or because the daemon came back on a new version). */
  markDone: (version: string) => void;
  /** Fold one progress answer into the state (see UpdateModal's poller). */
  applyProgress: (p: UpdateProgress) => void;
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
  failure: null,
  progress: null,
  progressUnreachable: false,
  runFailed: false,
  progressHidden: false,
  doneVersion: null,
  doneAt: null,
  donePlaying: false,
  markDone: (version) => {
    if (get().doneVersion) return;
    set({ doneVersion: version, doneAt: Date.now(), inProgress: false, progressHidden: false, progressUnreachable: false });
  },
  applyProgress: (p) => {
    const { inProgress } = get();
    if (p.state === 'running' || p.state === 'restarting') {
      // Also picks up an update that another client (or a page before a reload) started.
      set({ progress: p, progressUnreachable: false, inProgress: true, runFailed: false });
    } else if (p.state === 'done' && inProgress) {
      set({ progress: p });
      get().markDone(p.version ?? '');
    } else if (p.state === 'failed' && inProgress) {
      set({ progress: p, progressUnreachable: false, inProgress: false, runFailed: true, progressHidden: false, failure: p.error ?? 'The update failed.' });
    } else {
      set({ progress: p, progressUnreachable: false });
    }
  },
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
      set({ inProgress: true, failure: null });
    } else if (e.type === 'update:failed') {
      set({ inProgress: false, failure: typeof e.reason === 'string' ? e.reason : 'Update failed. Run dispatch update to retry.' });
    }
  },
  dismiss: () => set({ dismissedVersion: get().available?.version ?? null }),
}));
