import { create } from 'zustand';
import { api } from '../api/client';
import type { DopplerStatus, DopplerSecret, DopplerProject, DopplerConfig } from '../api/types';

interface SecretsState {
  status: DopplerStatus | null;
  secrets: DopplerSecret[];
  projects: DopplerProject[];
  configs: DopplerConfig[];
  loadStatus: () => Promise<void>;
  connect: (input: { token: string; project: string; config: string; enabled: boolean; readOnly: boolean }) => Promise<void>;
  disconnect: () => Promise<void>;
  loadProjects: () => Promise<void>;
  loadConfigs: (project: string) => Promise<void>;
  loadSecrets: () => Promise<void>;
  setSecret: (name: string, value: string) => Promise<void>;
  deleteSecret: (name: string) => Promise<void>;
}

// Server-backed: Doppler connection + secrets live on the daemon (/api/secrets),
// never in localStorage. Mirrors stores/servers.ts.
export const useSecrets = create<SecretsState>((set, get) => ({
  status: null,
  secrets: [],
  projects: [],
  configs: [],

  loadStatus: async () => {
    try {
      const status = await api.getSecretsStatus();
      set({ status });
      if (status.connected) await get().loadSecrets();
    } catch {
      set({ status: null });
    }
  },

  connect: async (input) => {
    const status = await api.setDopplerConnection(input);
    set({ status });
    if (status.connected) await get().loadSecrets();
  },

  disconnect: async () => {
    await api.disconnectDoppler();
    set({ status: null, secrets: [], configs: [] });
    await get().loadStatus();
  },

  loadProjects: async () => {
    set({ projects: await api.listDopplerProjects() });
  },

  loadConfigs: async (project) => {
    if (!project) { set({ configs: [] }); return; }
    set({ configs: await api.listDopplerConfigs(project) });
  },

  loadSecrets: async () => {
    const status = get().status;
    set({ secrets: await api.listSecrets({ project: status?.project ?? undefined, config: status?.config ?? undefined }) });
  },

  setSecret: async (name, value) => {
    await api.setSecret({ name, value });
    await get().loadSecrets();
  },

  deleteSecret: async (name) => {
    await api.deleteSecret(name);
    await get().loadSecrets();
  },
}));
