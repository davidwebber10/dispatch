import { create } from 'zustand';
import { api } from '../api/client';
import type { Session } from '../api/types';
import type { ServerEvent } from '../api/events-socket';
import { readSnapshot } from '../lib/launchSnapshot';
import { useHint } from './hint';

interface ProjectsState {
  sessions: Session[];
  activeId: string | null;
  load: () => Promise<void>;
  setActive: (id: string) => void;
  /** W2-I: the project goes from the list at once; the request follows. A failure puts it back,
   *  shows a hint and rejects (so a caller that goes on after a success does not). */
  archive: (id: string) => Promise<void>;
  /** W2-I: the name changes at once; a failure puts the old name back and shows a hint. */
  rename: (id: string, name: string) => Promise<boolean>;
  reorder: (order: string[]) => Promise<void>;
  applyEvent: (e: ServerEvent) => void;
}

export const useProjects = create<ProjectsState>((set, get) => ({
  // The last list seen on this device, drawn at once at launch; load() replaces it.
  sessions: readSnapshot()?.sessions ?? [],
  activeId: null,
  load: async () => {
    const sessions = await api.listSessions();
    set({ sessions, activeId: get().activeId ?? sessions[0]?.id ?? null });
  },
  setActive: (id) => set({ activeId: id }),
  archive: async (id) => {
    const before = get().sessions;
    const index = before.findIndex((s) => s.id === id);
    const activeBefore = get().activeId;
    const sessions = before.filter((s) => s.id !== id);
    const picked = activeBefore === id ? (sessions[0]?.id ?? null) : activeBefore;
    set({ sessions, activeId: picked });
    try {
      await api.archiveSession(id);
    } catch (e) {
      console.error('useProjects.archive: archiveSession failed, putting the project back', e);
      const now = get().sessions.slice();
      if (index >= 0 && !now.some((s) => s.id === id)) now.splice(Math.min(index, now.length), 0, before[index]);
      // Active again only when the owner is still on the project that took its place.
      set({ sessions: now, activeId: activeBefore === id && get().activeId === picked ? id : get().activeId });
      await get().load().catch(() => { /* offline: the project put back above stays */ });
      useHint.getState().show('The project could not be archived.');
      throw e;
    }
  },
  rename: async (id, name) => {
    const v = name.trim();
    if (!v) return false;
    const before = get().sessions.find((s) => s.id === id);
    if (before?.name === v) return true;
    const patch = (n: string) => set({ sessions: get().sessions.map((s) => (s.id === id ? { ...s, name: n } : s)) });
    patch(v);
    try {
      await api.updateSession(id, { name: v });
      return true;
    } catch (e) {
      console.error('useProjects.rename: updateSession failed, putting the name back', e);
      if (before && get().sessions.find((s) => s.id === id)?.name === v) patch(before.name);
      await get().load().catch(() => { /* offline */ });
      useHint.getState().show('The project could not be renamed.');
      return false;
    }
  },
  reorder: async (order) => {
    const map = new Map(get().sessions.map((s) => [s.id, s]));
    const ordered = order.map((id) => map.get(id)).filter(Boolean) as Session[];
    const rest = get().sessions.filter((s) => !order.includes(s.id));
    set({ sessions: [...ordered, ...rest] });
    try { await api.reorderSessions(order); }
    catch (e) { console.error('useProjects.reorder: reorderSessions failed, reloading', e); await get().load?.(); }
  },
  applyEvent: (e) => {
    if (e.type === 'session:created' && e.session) {
      set({ sessions: [e.session as Session, ...get().sessions] });
    } else if (e.type === 'session:status') {
      // The event carries the session's freshly-bumped lastActivityAt on activity edges,
      // so the project card's timestamp — and the "most recent" sort — track thread work
      // live instead of going stale until a full reload. The backend only bumps on REAL
      // activity, so a passive status flip (attach/resize) omits the field: adopt it only
      // when present, never clobbering the existing value with undefined.
      set({ sessions: get().sessions.map(s => s.id === e.sessionId
        ? { ...s, status: e.status as Session['status'], ...(e.lastActivityAt ? { lastActivityAt: e.lastActivityAt as string } : {}) }
        : s) });
    } else if (e.type === 'session:archived') {
      set({ sessions: get().sessions.filter(s => s.id !== e.sessionId) });
    } else if (e.type === 'session:updated') {
      void get().load();
    }
  },
}));
