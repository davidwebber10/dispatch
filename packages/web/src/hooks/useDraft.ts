import { useCallback, useEffect, useState } from 'react';

const PREFIX = 'dispatch:draft:';

function read(id: string): string {
  try { return localStorage.getItem(PREFIX + id) ?? ''; } catch { return ''; }
}

/**
 * An unsent text draft that survives a page reload. The PWA reloads on resume to
 * pick up new deploys (see watchForUpdates in main.tsx), and iOS evicts/reloads
 * backgrounded PWAs — either wipes plain useState, losing whatever the user had
 * typed but not sent. Persisting per-id to localStorage keeps the draft across the
 * reload; it's cleared on send. Returns [value, set, clear].
 */
export function useDraft(id: string): [string, (v: string) => void, () => void] {
  const [value, setValue] = useState<string>(() => read(id));

  // Re-load when the id changes (the component may be reused across threads
  // without remounting), so each thread keeps its own draft.
  useEffect(() => { setValue(read(id)); }, [id]);

  const set = useCallback((v: string) => {
    setValue(v);
    try { if (v) localStorage.setItem(PREFIX + id, v); else localStorage.removeItem(PREFIX + id); } catch { /* storage unavailable */ }
  }, [id]);

  const clear = useCallback(() => {
    setValue('');
    try { localStorage.removeItem(PREFIX + id); } catch { /* storage unavailable */ }
  }, [id]);

  return [value, set, clear];
}
