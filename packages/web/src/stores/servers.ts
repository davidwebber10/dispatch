import { create } from 'zustand';
import { api } from '../api/client';

export interface ServerOption {
  label: string;
  origin: string;
}

interface ServersState {
  servers: ServerOption[];
  load: () => Promise<void>;
  add: (label: string, origin: string) => Promise<void>;
  remove: (origin: string) => Promise<void>;
}

// Seeded per-deployment by the operator (DISPATCH_SERVERS env on the daemon) and
// fetched from /api/servers; editable from Settings (persisted on the daemon).
export const useServers = create<ServersState>((set) => ({
  servers: [],
  load: async () => {
    try { set({ servers: await api.listServers() }); } catch { /* none configured */ }
  },
  add: async (label, origin) => { set({ servers: await api.addServer(label, origin) }); },
  remove: async (origin) => { set({ servers: await api.removeServer(origin) }); },
}));

export function currentServer(servers: ServerOption[], origin: string = window.location.origin): ServerOption | undefined {
  return servers.find((s) => s.origin === origin);
}

export function currentLabel(servers: ServerOption[], origin: string = window.location.origin): string {
  return currentServer(servers, origin)?.label ?? 'Local';
}
