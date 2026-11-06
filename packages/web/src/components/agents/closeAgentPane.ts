import { useAgentUI } from '../../stores/agentUI';
import { useAgents } from '../../stores/agents';
import { useTabs } from '../../stores/tabs';

const q = (sel: string) => document.querySelector<HTMLElement>(sel);

// Leave the Automations pane (desktop). The tabs were never touched, so the tab view comes back
// on its own; this puts keyboard focus there too, instead of leaving it on a removed element.
// Focus goes to the tab that was active, or, with no tab, to the sidebar's Automations button.
export function closeAgentPane(): void {
  const { activeTabId } = useTabs.getState();
  const { schedules, selectedId } = useAgents.getState();
  const projectId = schedules.find((x) => x.id === selectedId)?.projectId;
  useAgentUI.getState().blur();
  // After the re-render: the tab strip and the sidebar pill exist only once the pane is gone.
  requestAnimationFrame(() => {
    const tab = activeTabId ? q(`[data-tab-id="${CSS.escape(activeTabId)}"]`) : null;
    const target = tab
      ?? (projectId ? q(`[data-automations-pill="${CSS.escape(projectId)}"]`) : null)
      ?? q('[data-automations-pill]');
    target?.focus();
  });
}
