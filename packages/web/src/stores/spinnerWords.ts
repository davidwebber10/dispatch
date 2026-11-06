import { create } from 'zustand';
import { api } from '../api/client';
import type { SpinnerVerbs } from '../api/types';

/**
 * The working words chosen in Settings → Harnesses → Claude Code (lib/spinnerWords.ts). Loaded once
 * at launch and updated when Settings saves, so the "Working…" indicator never fetches on its own.
 */
export const useSpinnerWords = create<{ verbs: SpinnerVerbs | null; load: () => Promise<void>; set: (v: SpinnerVerbs | null) => void }>((set) => ({
  verbs: null,
  load: async () => {
    try { set({ verbs: (await api.getHarnessSettings()).settings?.['claude-code']?.spinnerVerbs ?? null }); }
    catch { /* keep the default word */ }
  },
  set: (verbs) => set({ verbs }),
}));
