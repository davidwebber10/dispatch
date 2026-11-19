import { create } from 'zustand';
import { api } from '../api/client';
import type { MemoryScopeInfo, MemoryPageSummary, MemoryNote, MemorySettings } from '../api/types';
import type { ServerEvent } from '../api/server-events';

/**
 * The Memory tab's data (docs/superpowers/specs/2026-11-17-memory-design.md, part 5). The scopes,
 * the settings, and the pages, new notes and block of the scope on screen. `memory:changed` loads
 * the scope list again, and the open scope when it changed. A response older than the newest
 * request for the same thing is dropped (the ledger card's pattern).
 */
export interface MemoryState {
  /** Null until the first load (the tab is the only place that loads it). */
  scopes: MemoryScopeInfo[] | null;
  settings: MemorySettings | null;
  /** The scope on screen. Remembered per device. */
  scope: string;
  pages: MemoryPageSummary[] | null;
  notes: MemoryNote[] | null;
  block: { text: string; chars: number; cap: number } | null;
  error: string | null;
  setScope: (scope: string) => void;
  load: () => Promise<void>;
  loadScope: () => Promise<void>;
  updateSettings: (patch: Partial<Omit<MemorySettings, 'available'>>) => Promise<void>;
  applyEvent: (e: ServerEvent) => void;
  /** After a reconnect: load again, if the tab was ever shown. */
  reloadAll: () => Promise<void>;
}

const SCOPE_KEY = 'dispatch:memory-scope';
const loadScopeKey = (): string => { try { return localStorage.getItem(SCOPE_KEY) || 'you'; } catch { return 'you'; } };
const saveScopeKey = (v: string): void => { try { localStorage.setItem(SCOPE_KEY, v); } catch { /* ignore */ } };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

let scopeRequest = 0;
let listRequest = 0;

/** The project id of a scope key, else null. */
export const projectOfScope = (scope: string): string | null => (scope.startsWith('project:') ? scope.slice(8) : null);

export const useMemory = create<MemoryState>((set, get) => ({
  scopes: null,
  settings: null,
  scope: loadScopeKey(),
  pages: null,
  notes: null,
  block: null,
  error: null,
  setScope: (scope) => {
    saveScopeKey(scope);
    set({ scope, pages: null, notes: null, block: null });
    void get().loadScope();
  },
  load: async () => {
    const request = ++listRequest;
    try {
      const [{ scopes }, settings] = await Promise.all([api.memoryScopes(), api.memorySettings()]);
      if (request !== listRequest) return;
      set({ scopes, settings, error: null });
      // A remembered scope that is gone (a deleted project): back to You.
      if (!scopes.some((s) => s.scope === get().scope)) get().setScope('you');
    } catch (e) {
      if (request === listRequest) set({ error: message(e) });
    }
    await get().loadScope();
  },
  loadScope: async () => {
    const request = ++scopeRequest;
    const scope = get().scope;
    try {
      const [{ pages }, { notes }, block] = await Promise.all([
        api.memoryPages(scope), api.memoryNotes(scope, 'new'), api.memoryBlock(projectOfScope(scope)),
      ]);
      if (request === scopeRequest && get().scope === scope) set({ pages, notes, block, error: null });
    } catch (e) {
      if (request === scopeRequest) set({ error: message(e) });
    }
  },
  updateSettings: async (patch) => {
    try {
      const settings = await api.memoryUpdateSettings(patch);
      set({ settings, error: null });
    } catch (e) { set({ error: message(e) }); }
  },
  applyEvent: (e) => {
    if (e.type !== 'memory:changed' || typeof e.scope !== 'string') return;
    if (get().scopes === null) return; // never shown: nothing to keep current
    void get().load();
  },
  reloadAll: async () => { if (get().scopes !== null) await get().load(); },
}));
