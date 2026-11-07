import { usePluginRegistry, type InspectorTabProps } from './registry';
import { PluginBoundary } from './PluginBoundary';
import { Modal } from '../components/common/Modal';

/**
 * A plugin's right-column tab on a phone (no right column there): the thread's ⋯ menu opens it
 * in a full-height sheet, with the same props the desktop tab gets. Closes itself when the
 * plugin's tab goes away (disabled, removed).
 */
export function PluginTabSheet({ tabKey, terminalId, sessionId, onClose }: InspectorTabProps & { tabKey: string | null; onClose: () => void }) {
  const tab = usePluginRegistry((s) => (tabKey ? s.inspectorTabs.find((t) => t.key === tabKey) : undefined));
  const status = usePluginRegistry((s) => (tab ? s.status[tab.plugin] : undefined));
  const C = tab?.Component;
  return (
    <Modal open={!!tab} sheet title={tab?.label} onClose={onClose}>
      {tab && C && (
        <div data-testid="plugin-tab-sheet" data-plugin={tab.plugin} style={{ minHeight: 'calc(100dvh - 140px - env(safe-area-inset-top) - env(safe-area-inset-bottom))', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <PluginBoundary plugin={tab.plugin} resetKey={status?.at}><C terminalId={terminalId} sessionId={sessionId} /></PluginBoundary>
        </div>
      )}
    </Modal>
  );
}
