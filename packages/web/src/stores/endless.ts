import { create } from 'zustand';
import { api } from '../api/client';
import type { ServerEvent } from '../api/events-socket';
import type { EndlessImage, EndlessMessage, EndlessPaneThread, EndlessProject, EndlessProjectsResponse, EndlessTurnStatus } from '../api/types';

const PAGE = 60;

/** A sent message the daemon has not logged yet (a turn logs it after its summary wait). */
export interface PendingSend { id: number; text: string; projectName: string | null; images: EndlessImage[] }
let pendingSeq = 0;

/** The daemon answers 503 on every /api/endless route while Chat is starting or failed to start. */
const isUnavailable = (err: unknown): boolean => err instanceof Error && / failed: 503\b/.test(err.message);

interface EndlessStoreState {
  messages: EndlessMessage[];
  /** Shown at once under the log; each leaves when the daemon logs a user message or the turn ends. */
  pending: PendingSend[];
  hasMore: boolean;
  /** The window ends at the newest message, so live messages append. False after a search jump. */
  atTail: boolean;
  loadingOlder: boolean;
  loaded: boolean;
  /** Chat is starting or failed to start (503). Cleared by the next good load. */
  unavailable: boolean;
  filter: string | null;
  focus: number | null;
  /** Bumped by each send: the scroller then follows the end, even after a search jump. */
  sendCount: number;
  liveText: string;
  liveThinking: string;
  turn: { status: EndlessTurnStatus; error: string | null };
  projects: EndlessProject[];
  threads: EndlessPaneThread[];
  truncated: boolean;
  /** In-progress docs per project (the pane's "Docs (N)"); loaded on the first watch and the 60 s timer only. */
  docCounts: Record<string, number>;
  loadTail: () => Promise<void>;
  loadOlder: () => Promise<void>;
  openAt: (i: number) => Promise<void>;
  setFilter: (project: string | null) => Promise<void>;
  send: (text: string, project: string | null, images?: EndlessImage[]) => Promise<void>;
  retry: () => Promise<void>;
  stop: () => Promise<void>;
  refreshState: () => Promise<void>;
  loadProjects: () => Promise<void>;
  /** Errors are ignored: the old counts stay. */
  loadDocCounts: (ids: string[]) => Promise<void>;
  /** Keep the pane live while mounted: thread events, a 60 s timer and page resume reload it. Counted. */
  watch: () => void;
  unwatch: () => void;
  /** Socket reconnect: broadcasts were missed, so reload the tail (also recovers from `unavailable`). */
  resyncAfterReconnect: () => void;
  applyEvent: (e: ServerEvent) => void;
}

export const RELOAD_DEBOUNCE_MS = 600;
export const RELOAD_MAX_WAIT_MS = 3000;
export const RELOAD_EVERY_MS = 60_000;
const COARSE: Record<string, string> = { working: 'working', needs_you: 'needs_input', queued: 'queued', error: 'error', done: 'waiting', idle: 'waiting' };
const normalizePane = (v: EndlessProjectsResponse | EndlessProject[]): EndlessProjectsResponse =>
  Array.isArray(v) ? { projects: v, threads: [], truncated: false } : { projects: v.projects ?? [], threads: v.threads ?? [], truncated: !!v.truncated };

/** The pane rule: a project shows when it has activity. An in-progress doc alone does not make it show. */
export const paneShows = (p: EndlessProject, threads: EndlessPaneThread[]): boolean =>
  p.live + p.needsYou + p.openItems > 0 || p.messages > 0 || !!p.lastReport || threads.some((t) => t.project === p.id);

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
  let watchers = 0;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let maxWait: ReturnType<typeof setTimeout> | null = null;
  /** The last coarse status seen per terminal, for terminals the pane does not list. */
  const lastStatus = new Map<string, string>();
  let every: ReturnType<typeof setInterval> | null = null;
  let inflight = false;
  let again = false;
  const reload = async () => {
    if (inflight) { again = true; return; }
    inflight = true;
    try { await get().loadProjects(); } catch { /* the store keeps the old list */ }
    finally { inflight = false; if (again) { again = false; void reload(); } }
  };
  const schedule = () => {
    if (watchers === 0) return;
    const fire = () => {
      if (debounce) clearTimeout(debounce);
      if (maxWait) clearTimeout(maxWait);
      debounce = null; maxWait = null;
      void reload();
    };
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(fire, RELOAD_DEBOUNCE_MS);
    if (!maxWait) maxWait = setTimeout(fire, RELOAD_MAX_WAIT_MS);
  };
  /** The doc counts of the projects the pane shows. Never called for a thread event. */
  const loadCounts = () => {
    const { projects, threads } = get();
    const ids = projects.filter((p) => paneShows(p, threads)).map((p) => p.id);
    if (ids.length) void get().loadDocCounts(ids);
  };
  /** The first watch came before the first projects load: load the counts when that load lands. */
  let countsOnLoad = false;
  /** The newest doc counts request. */
  let countsSeq = 0;
  const onVisible = () => { if (document.visibilityState === 'visible') void reload(); };

  return {
    messages: [],
    hasMore: false,
    atTail: true,
    loadingOlder: false,
    loaded: false,
    unavailable: false,
    filter: null,
    focus: null,
    pending: [],
    sendCount: 0,
    liveText: '',
    liveThinking: '',
    turn: { status: 'idle', error: null },
    projects: [],
    threads: [],
    truncated: false,
    docCounts: {},

    loadTail: () => {
      const g = ++gen;
      set({ loadingOlder: false });
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
      const item: PendingSend = { id: ++pendingSeq, text, projectName: get().projects.find((p) => p.id === project)?.name ?? null, images };
      set({ pending: [...get().pending, item], sendCount: get().sendCount + 1 });
      try {
        await api.endlessSend(text, project, images);
      } catch (err) {
        set({ pending: get().pending.filter((p) => p.id !== item.id) });
        throw err;
      }
      // A jump inside the tail leaves atTail true and the scroller in its jump mode: drop the
      // focus and ask the scroller to follow the end, so the reply comes into view.
      set({ focus: null });
    },
    retry: async () => { await api.endlessRetry(); },
    stop: async () => { await api.endlessStop(); },
    refreshState: () => load(() => api.endlessState(), (s) => set({ turn: s.turn })),
    loadProjects: () => load(() => api.endlessProjects(), (v) => {
      const p = normalizePane(v);
      set({ projects: p.projects, threads: p.threads, truncated: p.truncated });
      if (countsOnLoad && watchers > 0) { countsOnLoad = false; loadCounts(); }
    }),
    loadDocCounts: async (ids) => {
      const seq = ++countsSeq;
      try {
        const r = await api.endlessDocCounts(ids);
        if (seq === countsSeq) set({ docCounts: r.counts ?? {} }); // an answer older than the newest request is dropped
      } catch { /* keep the old counts */ }
    },
    watch: () => {
      watchers++;
      if (watchers > 1) return;
      every = setInterval(() => { if (document.visibilityState === 'visible') void reload().then(loadCounts); }, RELOAD_EVERY_MS);
      document.addEventListener('visibilitychange', onVisible);
      if (get().projects.some((p) => paneShows(p, get().threads))) loadCounts();
      else countsOnLoad = true;
    },
    unwatch: () => {
      if (watchers === 0) return;
      watchers--;
      if (watchers > 0) return;
      if (every) clearInterval(every);
      if (debounce) clearTimeout(debounce);
      if (maxWait) clearTimeout(maxWait);
      every = null; debounce = null; maxWait = null; countsOnLoad = false;
      document.removeEventListener('visibilitychange', onVisible);
    },

    resyncAfterReconnect: () => {
      if (watchers > 0) void reload();
      const { loaded, unavailable, atTail } = get();
      if (!unavailable && !(loaded && atTail)) return;
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
        // The daemon logged a user message: the oldest pending send is now in the log.
        if (m.kind === 'user' && get().pending.length) patch.pending = get().pending.slice(1);
        if (atTail && (filter === null || m.project === filter) && !messages.some((x) => x.i === m.i)) patch.messages = [...messages, m];
        set(patch);
        // A thread report changes its project's "last report" in the projects panel.
        if (m.kind === 'work') void get().loadProjects().catch(() => {});
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
          set({ turn, liveText: '', liveThinking: '', pending: [] });
          void get().loadProjects().catch(() => {});
        } else {
          set({ turn });
        }
        return;
      }
      if (e.type === 'terminal:created' || e.type === 'terminal:exit' || e.type === 'terminal:removed') { schedule(); return; }
      if (e.type === 'terminal:status' && typeof e.terminalId === 'string') {
        if (typeof e.status !== 'string') return;
        const id = e.terminalId;
        const known = get().threads.find((t) => t.id === id);
        const prev = known ? COARSE[known.state] : lastStatus.get(id);
        lastStatus.set(id, e.status);
        // A terminal the pane never saw and that just waits has nothing to show.
        if (prev === undefined ? e.status !== 'waiting' : prev !== e.status) schedule();
      }
    },
  };
});
