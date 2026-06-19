import { create } from 'zustand';
import { api } from '../api/client';
import type { AuthRequest } from '../api/types';
import type { ServerEvent } from '../api/events-socket';

interface AuthState {
  requests: AuthRequest[];
  load: () => Promise<void>;
  applyEvent: (e: ServerEvent) => void;
}

export const useAuth = create<AuthState>((set, get) => ({
  requests: [],
  load: async () => { set({ requests: await api.listAuthRequests() }); },
  applyEvent: (e) => {
    if ((e.type === 'auth:request' || e.type === 'auth:updated') && e.request) {
      const r = e.request as AuthRequest;
      set({ requests: [r, ...get().requests.filter((x) => x.id !== r.id)] });
    }
  },
}));
