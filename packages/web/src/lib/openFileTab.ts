import { api } from '../api/client';
import { useTabs } from '../stores/tabs';
import { useUI } from '../stores/ui';

/**
 * Open (or create) the FILE tab for `path` in a project — the shared body behind every
 * "View file" link. Reuses an existing file tab for the same path so repeated clicks
 * never pile up duplicates. Returns the tab id, or null when no tab could be made.
 *
 * `focus` decides what happens AFTER the tab exists:
 * - true  — also request navigation to it (ChatView's behavior: you're already on the
 *   Threads surface, so the file should come to front).
 * - false — open it and STAY PUT (the Control Plane's behavior, Jason's call: the tab
 *   waits on the Threads surface; on mobile a navigation request would yank the reader
 *   out of the Overseer mid-read).
 */
export async function openFileTab(sessionId: string, path: string, opts: { focus: boolean }): Promise<string | null> {
  if (!sessionId) return null;
  const st = useTabs.getState();
  const existing = (st.byProject[sessionId] ?? []).find((t) => t.type === 'file' && (t.config?.path as string) === path);
  let id = existing?.id;
  if (!id) {
    try {
      const t = await api.createTerminal(sessionId, { type: 'file', label: path.split('/').pop() || path, config: { path } });
      await st.loadTabs(sessionId);
      id = t.id;
    } catch {
      return null;
    }
  }
  st.openTab(id);
  if (opts.focus) useUI.getState().requestOpenTab(id);
  return id;
}
