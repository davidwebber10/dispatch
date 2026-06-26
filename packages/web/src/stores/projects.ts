import { create } from 'zustand';
import { api } from '../api/client';
import type { Session } from '../api/types';
import type { ServerEvent } from '../api/events-socket';

interface ProjectsState {
  sessions: Session[];
  activeId: string | null;
  load: () => Promise<void>;
  setActive: (id: string) => void;
  archive: (id: string) => Promise<void>;
  reorder: (order: string[]) => Promise<void>;
  applyEvent: (e: ServerEvent) => void;
}

export const useProjects = create<ProjectsState>((set, get) => ({
  sessions: [],
  activeId: null,
  load: async () => {
    const sessions = await api.listSessions();
    set({ sessions, activeId: get().activeId ?? sessions[0]?.id ?? null });
  },
  setActive: (id) => set({ activeId: id }),
  archive: async (id) => {
    await api.archiveSession(id);
    const sessions = get().sessions.filter((s) => s.id !== id);
    const activeId = get().activeId === id ? (sessions[0]?.id ?? null) : get().activeId;
    set({ sessions, activeId });
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
      set({ sessions: get().sessions.map(s => s.id === e.sessionId ? { ...s, status: e.status as Session['status'] } : s) });
    } else if (e.type === 'session:archived') {
      set({ sessions: get().sessions.filter(s => s.id !== e.sessionId) });
    } else if (e.type === 'session:updated') {
      void get().load();
    }
  },
}));
