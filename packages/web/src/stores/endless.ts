import { create } from 'zustand';
import { api } from '../api/client';
import type { ServerEvent } from '../api/events-socket';
import type { EndlessImage, EndlessMessage, EndlessProject, EndlessTurnStatus } from '../api/types';

const PAGE = 60;

/** The daemon answers 503 on every /api/endless route while Chat is starting or failed to start. */
const isUnavailable = (err: unknown): boolean => err instanceof Error && / failed: 503\b/.test(err.message);

interface EndlessStoreState {
  messages: EndlessMessage[];
  hasMore: boolean;
  /** The window ends at the newest message, so live messages append. False after a search jump. */
  atTail: boolean;
  loadingOlder: boolean;
  loaded: boolean;
  /** Chat is starting or failed to start (503). Cleared by the next good load. */
  unavailable: boolean;
  filter: string | null;
  focus: number | null;
  liveText: string;
  liveThinking: string;
  turn: { status: EndlessTurnStatus; error: string | null };
  projects: EndlessProject[];
  loadTail: () => Promise<void>;
  loadOlder: () => Promise<void>;
  openAt: (i: number) => Promise<void>;
  setFilter: (project: string | null) => Promise<void>;
  send: (text: string, project: string | null, images?: EndlessImage[]) => Promise<void>;
  retry: () => Promise<void>;
  refreshState: () => Promise<void>;
  loadProjects: () => Promise<void>;
  applyEvent: (e: ServerEvent) => void;
}

export const useEndless = create<EndlessStoreState>((set, get) => {
  /** Run a load; a 503 sets `unavailable` instead of throwing, a good result clears it. */
  const load = async <T,>(fetcher: () => Promise<T>, apply: (v: T) => void): Promise<void> => {
    let v: T;
    try {
      v = await fetcher();
    } catch (err) {
      if (isUnavailable(err)) { set({ unavailable: true, loaded: false }); return; }
      throw err;
    }
    set({ unavailable: false });
    apply(v);
  };

  return {
    messages: [],
    hasMore: false,
    atTail: true,
    loadingOlder: false,
    loaded: false,
    unavailable: false,
    filter: null,
    focus: null,
    liveText: '',
    liveThinking: '',
    turn: { status: 'idle', error: null },
    projects: [],

    loadTail: () => load(
      () => api.endlessMessages({ limit: PAGE, project: get().filter }),
      (page) => set({ messages: page.messages, hasMore: page.hasMore, atTail: true, focus: null, loaded: true }),
    ),
    loadOlder: async () => {
      const { messages, hasMore, loadingOlder, filter } = get();
      if (!hasMore || loadingOlder || messages.length === 0) return;
      set({ loadingOlder: true });
      try {
        await load(
          () => api.endlessMessages({ before: messages[0].i, limit: PAGE, project: filter }),
          (page) => set({ messages: [...page.messages, ...get().messages], hasMore: page.hasMore }),
        );
      } finally {
        set({ loadingOlder: false });
      }
    },
    openAt: (i) => load(
      () => api.endlessMessages({ around: i, limit: PAGE, project: get().filter }),
      (page) => set({ messages: page.messages, hasMore: page.hasMore, atTail: !page.hasMoreAfter, focus: i, loaded: true }),
    ),
    setFilter: async (project) => {
      set({ filter: project });
      await get().loadTail();
    },
    send: async (text, project, images = []) => {
      if (!get().atTail) await get().loadTail();
      await api.endlessSend(text, project, images);
    },
    retry: async () => { await api.endlessRetry(); },
    refreshState: () => load(() => api.endlessState(), (s) => set({ turn: s.turn })),
    loadProjects: () => load(() => api.endlessProjects(), (projects) => set({ projects })),

    applyEvent: (e) => {
      if (e.type === 'endless:message') {
        const m = e.message as EndlessMessage;
        const { atTail, filter, messages } = get();
        const patch: Partial<EndlessStoreState> = {};
        if (m.kind === 'unii') patch.liveText = '';
        if (m.kind === 'unii' || m.kind === 'tool') patch.liveThinking = '';
        if (atTail && (filter === null || m.project === filter) && !messages.some((x) => x.i === m.i)) patch.messages = [...messages, m];
        set(patch);
        return;
      }
      if (e.type === 'endless:delta') {
        const text = String(e.text ?? '');
        if (e.kind === 'thinking') set({ liveThinking: get().liveThinking + text });
        else set({ liveText: get().liveText + text });
        return;
      }
      if (e.type === 'endless:turn') {
        const status = e.status as EndlessTurnStatus;
        const turn = { status, error: typeof e.error === 'string' ? e.error : null };
        if (status === 'idle' || status === 'failed') {
          set({ turn, liveText: '', liveThinking: '' });
          void get().loadProjects().catch(() => {});
        } else {
          set({ turn });
        }
      }
    },
  };
});
