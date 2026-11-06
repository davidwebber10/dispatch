import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { ChatSettings } from '../../api/types';

const NOTE = 'Saved for all of Chat. Applies from the next turn.';

/**
 * Chat's one model and effort (slash menu, 2026-11-06). Chat starts a new process for every turn, so
 * a change takes hold at the next turn and stays until changed again. `null` is the default.
 */
export function useChatSettings() {
  const [settings, setSettings] = useState<ChatSettings | null>(null);
  useEffect(() => {
    let live = true;
    api.endlessSettings().then((s) => { if (live) setSettings(s); }).catch(() => { /* an older daemon has no setting: the picker stays off */ });
    return () => { live = false; };
  }, []);
  const apply = useCallback(async (change: { model?: string | null; effort?: string | null }): Promise<string> => {
    setSettings(await api.setEndlessSettings(change));
    return NOTE;
  }, []);
  return { settings, apply };
}
