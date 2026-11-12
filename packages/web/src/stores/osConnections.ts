import { create } from 'zustand';
import { api, type OsConnections, type OsToolsList } from '../api/client';

/**
 * The person's company connections on a hosted box (core os/tools-proxy.ts): what OS last said
 * (consent cards, reachability, the public OS address), and OS's tool list for the panel. The daemon
 * broadcasts `os:connections` when OS's answer changes; App.tsx routes it here. A local daemon
 * answers `hosted: false` and the panel shows nothing.
 */
interface OsConnectionsState {
  state: OsConnections | null;
  tools: OsToolsList | null;
  checking: boolean;
  load: () => Promise<void>;
  /** "Check again": OS is asked now (after the person connected a system in OS). */
  checkAgain: () => Promise<void>;
  applyEvent: (e: any) => void;
}

export const useOsConnections = create<OsConnectionsState>((set, get) => ({
  state: null,
  tools: null,
  checking: false,
  load: async () => {
    try {
      const state = await api.getOsConnections();
      set({ state });
      if (state.hosted && state.osToolsEnabled) set({ tools: await api.getOsTools() });
    } catch { /* an older daemon has no route: the panel stays hidden */ }
  },
  checkAgain: async () => {
    set({ checking: true });
    try {
      const state = await api.refreshOsConnections();
      set({ state });
      if (state.osToolsEnabled) set({ tools: await api.getOsTools() });
    } catch { /* the panel keeps the last answer */ }
    finally { set({ checking: false }); }
  },
  applyEvent: (e) => {
    if (e?.type !== 'os:connections' || !e.state) return;
    set({ state: e.state });
    if (e.state.osToolsEnabled && get().tools) void api.getOsTools().then((tools) => set({ tools })).catch(() => {});
  },
}));

/** An OS address for a connect link: an absolute URL as it is; a path under OS's public address. */
export function osLink(pathOrUrl: string, osPublicUrl: string | null | undefined): string | null {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  if (!osPublicUrl || !pathOrUrl.startsWith('/')) return null;
  return osPublicUrl.replace(/\/+$/, '') + pathOrUrl;
}

/** The `not_connected` code of a company tool result (OS's JSON in the result text), or null. */
export function notConnectedOf(text: string | undefined): { system: string; label: string; connect: string | null } | null {
  if (!text || !text.includes('not_connected')) return null;
  try {
    const j = JSON.parse(text.trim());
    if (j?.error !== 'not_connected' && j?.code !== 'not_connected') return null;
    const system = typeof j.system === 'string' ? j.system : typeof j.system_id === 'string' ? j.system_id : '';
    // Contract 2026-11-11: `connect_url`. Older shapes: connectUrl, connectPath.
    const connect = [j.connect_url, j.connectUrl, j.connectPath, j.connect_path].find((v): v is string => typeof v === 'string' && !!v) ?? null;
    if (!system && !connect) return null;
    const label = typeof j.label === 'string' && j.label ? j.label : system || 'this system';
    return { system, label, connect };
  } catch { return null; }
}
