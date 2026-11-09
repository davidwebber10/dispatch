import { useCallback, useEffect } from 'react';
import { useEndless } from '../../stores/endless';

const NOTE = 'Saved for all of Chat. Applies from the next message.';

/**
 * Chat's one model and effort (slash menu). Chat starts a new process for every turn, so a change takes hold at the next
 * turn and stays until changed again. `null` is the default. The settings live in the Chat store: the daemon announces a
 * change (`endless:settings`) so a second open device takes it without a reload, and `reload` asks again (the chip does,
 * when it opens, in case an announcement was missed).
 */
export function useChatSettings() {
  const settings = useEndless((s) => s.settings);
  useEffect(() => { void useEndless.getState().loadSettings(); }, []);
  const reload = useCallback(() => useEndless.getState().loadSettings(), []);
  const apply = useCallback(async (change: { model?: string | null; effort?: string | null }): Promise<string> => {
    await useEndless.getState().saveSettings(change); // the store keeps only the newest answer
    return NOTE;
  }, []);
  return { settings, apply, reload };
}
