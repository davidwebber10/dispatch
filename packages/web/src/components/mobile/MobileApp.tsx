import { useState } from 'react';
import { Gear } from '@phosphor-icons/react';
import { ConnectionStatus } from '../layout/ConnectionStatus';
import { BrandSwitcher } from '../layout/BrandSwitcher';
import { ProjectSidebar } from '../sidebar/ProjectSidebar';
import { TabHost } from '../tabs/TabHost';
import { AgentPane } from '../agents/AgentPane';
import { EditAgentModal } from '../agents/EditAgentModal';
import { SettingsModal } from '../settings/SettingsModal';
import { useTabs } from '../../stores/tabs';
import { useAgentUI } from '../../stores/agentUI';

export function MobileApp() {
  const activeTab = useTabs((s) => s.activeTabId);
  const editing = useAgentUI((s) => s.editing);
  const [screen, setScreen] = useState<'list' | 'tab' | 'agent'>('list');
  const [settings, setSettings] = useState(false);

  const openTab = (id: string) => { useAgentUI.getState().blur(); useTabs.getState().setActiveTab(id); setScreen('tab'); };
  const openAgent = (id: string) => { useAgentUI.getState().selectAgent(id); setScreen('agent'); };
  const detail = screen !== 'list';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--color-base)' }}>
      <header style={{ height: 'calc(50px + env(safe-area-inset-top))', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', paddingTop: 'env(safe-area-inset-top)', background: 'var(--color-pane)', borderBottom: '1px solid var(--color-border)' }}>
        {detail ? (
          <button onClick={() => setScreen('list')} style={{ background: 'none', border: 'none', color: 'var(--color-accent)', fontSize: 15, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 2 }}>‹ Projects</button>
        ) : (
          <BrandSwitcher />
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <ConnectionStatus />
          <button title="Settings" onClick={() => setSettings(true)} style={{ width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, background: 'var(--color-elevated)', border: '1px solid #2C2C32', color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
            <Gear size={17} />
          </button>
        </div>
      </header>
      <SettingsModal open={settings} onClose={() => setSettings(false)} />

      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {screen === 'list' && (
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            <ProjectSidebar onSelectTab={openTab} onSelectAgent={openAgent} onNewAgent={(pid) => useAgentUI.getState().openNew(pid)} />
          </div>
        )}
        {screen === 'tab' && (activeTab ? <TabHost key={activeTab} terminalId={activeTab} /> : <div style={{ padding: 16, color: 'var(--color-text-secondary)' }}>No thread open</div>)}
        {screen === 'agent' && <AgentPane />}
      </div>

      {editing && <EditAgentModal scheduleId={editing.scheduleId} presetProjectId={editing.preset} onClose={() => useAgentUI.getState().closeEdit()} onSaved={(id) => { useAgentUI.getState().selectAgent(id); setScreen('agent'); }} />}
    </div>
  );
}
