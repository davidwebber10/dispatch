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
  /** Socket reconnect: broadcasts were missed, so reload the tail (also recovers from `unavailable`). */
  resyncAfterReconnect: () => void;
  applyEvent: (e: ServerEvent) => void;
}

export const useEndless = create<EndlessStoreState>((set, get) => {
  /** Run a load; a 503 sets `unavailable` instead of throwing, a good result clears it. */
  const load = async <T,>(fetcher: () => Promise<T>, apply: (v: T) => void, myGen?: number): Promise<void> => {
    let v: T;
    try {
      v = await fetcher();
    } catch (err) {
      if (myGen !== undefined && myGen !== gen) return;
      if (isUnavailable(err)) { set({ unavailable: true, loaded: false }); return; }
      throw err;
    }
    if (myGen !== undefined && myGen !== gen) return; // a newer window load replaced this one
    set({ unavailable: false });
    apply(v);
  };
  /** Bumped by every load that replaces the window; a load that started under an older value is dropped. */
  let gen = 0;

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

    loadTail: () => {
      const g = ++gen;
      return load(
        () => api.endlessMessages({ limit: PAGE, project: get().filter }),
        (page) => {
          // A broadcast can land after the server built the page but before this runs: keep it.
          const { filter, messages, atTail } = get();
          const last = page.messages.length ? page.messages[page.messages.length - 1].i : -1;
          const newer = atTail ? messages.filter((m) => m.i > last && (filter === null || m.project === filter)) : [];
          set({ messages: [...page.messages, ...newer], hasMore: page.hasMore, atTail: true, focus: null, loaded: true });
        },
        g,
      );
    },
    loadOlder: async () => {
      const { messages, hasMore, loadingOlder, filter } = get();
      if (!hasMore || loadingOlder || messages.length === 0) return;
      const g = gen;
      set({ loadingOlder: true });
      try {
        await load(
          () => api.endlessMessages({ before: messages[0].i, limit: PAGE, project: filter }),
          (page) => {
            const have = new Set(get().messages.map((m) => m.i));
            set({ messages: [...page.messages.filter((m) => !have.has(m.i)), ...get().messages], hasMore: page.hasMore });
          },
          g,
        );
      } finally {
        if (g === gen) set({ loadingOlder: false });
      }
    },
    openAt: (i) => {
      const g = ++gen;
      set({ loadingOlder: false });
      return load(
        () => api.endlessMessages({ around: i, limit: PAGE, project: get().filter }),
        (page) => set({ messages: page.messages, hasMore: page.hasMore, atTail: !page.hasMoreAfter, focus: i, loaded: true }),
        g,
      );
    },
    setFilter: async (project) => {
      gen++;
      set({ filter: project, loadingOlder: false });
      await get().loadTail();
    },
    send: async (text, project, images = []) => {
      if (!get().atTail) await get().loadTail();
      await api.endlessSend(text, project, images);
    },
    retry: async () => { await api.endlessRetry(); },
    refreshState: () => load(() => api.endlessState(), (s) => set({ turn: s.turn })),
    loadProjects: () => load(() => api.endlessProjects(), (projects) => set({ projects })),

    resyncAfterReconnect: () => {
      const { loaded, unavailable, atTail } = get();
      if (!(loaded || unavailable) || !atTail) return;
      void get().loadTail().catch(() => {});
      void get().refreshState().catch(() => {});
    },

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
        if (status === 'idle' || status === 'failed' || status === 'interrupted') {
          set({ turn, liveText: '', liveThinking: '' });
          void get().loadProjects().catch(() => {});
        } else {
          set({ turn });
        }
      }
    },
  };
});
