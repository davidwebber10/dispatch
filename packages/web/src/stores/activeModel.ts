import { create } from 'zustand';
import type { Terminal } from '../api/types';

/**
 * The model each Pretty thread runs NOW, as the harness last reported it (see lib/modelName's
 * modelFromFrame). Written by useStructuredChat from its stream; cleared when a view of the thread
 * opens, so a model from an earlier view (before a CLI round trip) never shows — the daemon sends
 * the current one as the first thing after the replay (`system/model`).
 */
interface ActiveModelState {
  byTerminal: Record<string, string>;
  set: (terminalId: string, model: string) => void;
  clear: (terminalId: string) => void;
}

export const useActiveModel = create<ActiveModelState>((set, get) => ({
  byTerminal: {},
  set: (terminalId, model) => {
    if (get().byTerminal[terminalId] === model) return;
    set({ byTerminal: { ...get().byTerminal, [terminalId]: model } });
  },
  clear: (terminalId) => {
    if (!(terminalId in get().byTerminal)) return;
    const next = { ...get().byTerminal };
    delete next[terminalId];
    set({ byTerminal: next });
  },
}));

/** The active model of a thread: the reported one, else its saved `config.model`, else undefined. */
export function activeModelOf(byTerminal: Record<string, string>, tab: Pick<Terminal, 'id' | 'config'> | undefined): string | undefined {
  if (!tab) return undefined;
  const live = byTerminal[tab.id];
  if (live) return live;
  const saved = (tab.config as { model?: unknown } | undefined)?.model;
  return typeof saved === 'string' && saved ? saved : undefined;
}

/** Hook form of activeModelOf. */
export function useActiveModelFor(tab: Pick<Terminal, 'id' | 'config'> | undefined): string | undefined {
  const live = useActiveModel((s) => (tab ? s.byTerminal[tab.id] : undefined));
  return live ?? activeModelOf({}, tab);
}
