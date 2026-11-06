import { api } from '../api/client';
import { fileKind } from './docPaths';
import { openFileTab } from './openFileTab';
import { saveFileAs } from './saveFiles';
import { useDocViewer } from '../stores/docViewer';
import { useUI } from '../stores/ui';

/**
 * Where a file tab goes after it opens: `threads` (a thread's own view: bring the tab to front),
 * `chat` (the Chat page: switch to the Threads view on the tab; desktop and phone read the same
 * request) or `stay` (the Control Plane: the tab waits on the Threads surface).
 */
export type FileNav = 'threads' | 'chat' | 'stay';

/**
 * What a click on a file chip does, by kind of file. A doc (.md, .markdown, .txt) opens the doc viewer.
 * A text or code file, a CSV or an image opens a file tab (the file tab already shows each of them).
 * Any other binary (xlsx, parquet, pdf, zip, ...) has no viewer, so it downloads from the project.
 */
export async function openChipFile(o: { project: string; path: string; branch: string | null; nav: FileNav; origin?: string }): Promise<void> {
  const { project, path, branch, nav, origin } = o;
  const kind = fileKind(path);
  if (kind === 'doc') {
    useDocViewer.getState().show({ project, path, branch, origin });
    return;
  }
  if (kind === 'binary') {
    try { await saveFileAs(api.downloadUrl(project, path), path.split('/').pop() || path); }
    catch (err) { window.alert(`Download failed: ${err instanceof Error ? err.message : String(err)}`); }
    return;
  }
  const id = await openFileTab(project, path, { focus: nav === 'threads' });
  if (nav === 'chat' && id) {
    useUI.getState().requestOpenThread({ sessionId: project, terminalId: id });
    useUI.getState().setView('workspace'); // the "Threads" view; `workspace` is its code name
  }
}
