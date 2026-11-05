import { create } from 'zustand';
import { api } from '../api/client';
import type { UsageSummary } from '../api/types';
import type { ServerEvent } from '../api/events-socket';

/**
 * The usage gauge (#127): every provider's limit figures and every thread paused on a limit,
 * for the header chip, the paused banner and Settings > Usage limits. Loaded at boot and on a
 * reconnect (lib/resync.ts), then kept fresh by the daemon's throttled `usage-limits` event.
 * Null until the first load answers.
 */
interface UsageLimitsState {
  summary: UsageSummary | null;
  load: () => Promise<void>;
  applyEvent: (e: ServerEvent) => void;
}

function parse(e: Record<string, unknown>): UsageSummary | null {
  if (typeof e.warnPercent !== 'number' || !Array.isArray(e.providers) || !Array.isArray(e.paused)) return null;
  return {
    ...(typeof e.at === 'number' ? { at: e.at } : {}),
    warnPercent: e.warnPercent,
    ...(typeof e.pushOnWarn === 'boolean' ? { pushOnWarn: e.pushOnWarn } : {}),
    providers: e.providers as UsageSummary['providers'],
    paused: e.paused as UsageSummary['paused'],
  };
}

export const useUsageLimits = create<UsageLimitsState>((set, get) => {
  /** Keep the newest: a body the daemon built earlier than the one held (a slow GET after a pause event) is dropped. A body with no stamp always applies. */
  const accept = (s: UsageSummary) => {
    const have = get().summary?.at;
    if (have !== undefined && s.at !== undefined && s.at < have) return;
    set({ summary: s });
  };
  return {
    summary: null,
    load: async () => {
      try {
        const s = parse((await api.getUsageSummary()) as unknown as Record<string, unknown>);
        if (s) accept(s);
      } catch { /* an older daemon has no gauge: keep what is there */ }
    },
    applyEvent: (e) => {
      if (e.type !== 'usage-limits') return;
      const s = parse(e);
      if (s) accept(s);
    },
  };
});
