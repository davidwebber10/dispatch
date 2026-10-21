import { useTabs } from '../../stores/tabs';
import { useOverseer } from '../overseer/store';

/** Open a thread in the Overseer lightbox over Chat (spec 3.6). The lightbox picks ChatView or the terminal from the loaded tabs. */
export async function openThreadInPlace(projectId: string, terminalId: string): Promise<void> {
  if (!useTabs.getState().byProject[projectId]) {
    try { await useTabs.getState().loadTabs(projectId); } catch { /* open anyway: a structured thread still renders */ }
  }
  useOverseer.getState().drillInto(terminalId);
}
