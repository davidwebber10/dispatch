import { create } from 'zustand';
import { api } from '../api/client';
import type { Preview } from '../api/types';
import type { ServerEvent } from '../api/events-socket';

/**
 * Previews (docs/superpowers/specs/2026-10-28-previews-design.md): everything a thread handed the
 * user to look at or copy, newest first, across projects. Loaded once on first use and kept fresh
 * by the `preview:new` / `preview:changed` events; a reconnect reloads (App.tsx resync).
 *
 * `sheet` is the project whose previews the phone's sheet shows (the Previews key next to esc and
 * the header button open it); null when closed. The desktop rail view reads `items` directly.
 */
interface PreviewsState {
  items: Preview[];
  loaded: boolean;
  loading: boolean;
  sheet: string | null;
  load: () => Promise<void>;
  applyEvent: (e: ServerEvent) => void;
  markSeen: (id: string) => Promise<void>;
  /** Mark every unseen preview of a project (or all) seen: the list was just shown. */
  markAllSeen: (sessionId?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  openSheet: (sessionId: string) => void;
  closeSheet: () => void;
}

const newestFirst = (a: Preview, b: Preview) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);

export const usePreviews = create<PreviewsState>((set, get) => ({
  items: [],
  loaded: false,
  loading: false,
  sheet: null,
  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const r = await api.listPreviews();
      set({ items: [...r.previews].sort(newestFirst), loaded: true });
    } catch { /* keep what is there; the next event or reconnect tries again */ }
    finally { set({ loading: false }); }
  },
  applyEvent: (e) => {
    if (e.type === 'preview:new' && e.preview && typeof e.preview === 'object') {
      const p = e.preview as Preview;
      set({ items: [p, ...get().items.filter((x) => x.id !== p.id)] });
    } else if (e.type === 'preview:changed' && typeof e.id === 'string') {
      if (e.deleted === true) set({ items: get().items.filter((x) => x.id !== e.id) });
      else if (typeof e.seenAt === 'string') set({ items: get().items.map((x) => (x.id === e.id ? { ...x, seenAt: e.seenAt as string } : x)) });
    }
  },
  markSeen: async (id) => {
    const now = new Date().toISOString();
    // Optimistic: the badge drops at once; the event confirms with the daemon's time.
    set({ items: get().items.map((x) => (x.id === id && !x.seenAt ? { ...x, seenAt: now } : x)) });
    try { await api.markPreviewSeen(id); } catch { /* the next load corrects it */ }
  },
  markAllSeen: async (sessionId) => {
    const unseen = get().items.filter((x) => !x.seenAt && (!sessionId || x.sessionId === sessionId));
    await Promise.all(unseen.map((x) => get().markSeen(x.id)));
  },
  remove: async (id) => {
    const before = get().items;
    set({ items: before.filter((x) => x.id !== id) });
    try { await api.deletePreview(id); } catch { set({ items: before }); }
  },
  openSheet: (sessionId) => set({ sheet: sessionId }),
  closeSheet: () => set({ sheet: null }),
}));

/** Unseen previews, for a project or for all. */
export const unseenPreviews = (items: Preview[], sessionId?: string | null): number =>
  items.reduce((n, x) => n + (!x.seenAt && (!sessionId || x.sessionId === sessionId) ? 1 : 0), 0);
