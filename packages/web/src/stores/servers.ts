import { create } from 'zustand';
import { api } from '../api/client';

export interface ServerOption {
  label: string;
  origin: string;
}

interface ServersState {
  servers: ServerOption[];
  load: () => Promise<void>;
}

// The list is configured per-deployment by the operator (DISPATCH_SERVERS env on
// the daemon) and fetched from /api/servers. Empty by default.
export const useServers = create<ServersState>((set) => ({
  servers: [],
  load: async () => {
    try { set({ servers: await api.listServers() }); } catch { /* none configured */ }
  },
}));

export function currentServer(servers: ServerOption[], origin: string = window.location.origin): ServerOption | undefined {
  return servers.find((s) => s.origin === origin);
}

export function currentLabel(servers: ServerOption[], origin: string = window.location.origin): string {
  return currentServer(servers, origin)?.label ?? 'Local';
}
