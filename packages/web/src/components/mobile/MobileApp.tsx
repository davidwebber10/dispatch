import { useState } from 'react';
import { Gear } from '@phosphor-icons/react';
import { ConnectionStatus } from '../layout/ConnectionStatus';
import { BrandSwitcher } from '../layout/BrandSwitcher';
import { ProjectSidebar } from '../sidebar/ProjectSidebar';
import { TabHost } from '../tabs/TabHost';
import { AgentsView } from '../agents/AgentsView';
import { SettingsModal } from '../settings/SettingsModal';
import { useUI } from '../../stores/ui';
import { useTabs } from '../../stores/tabs';

export function MobileApp() {
  const view = useUI((s) => s.view);
  const setView = useUI((s) => s.setView);
  const activeTab = useTabs((s) => s.activeTabId);
  const [screen, setScreen] = useState<'list' | 'tab'>('list');
  const [settings, setSettings] = useState(false);

  function openTab(id: string) { useTabs.getState().setActiveTab(id); setScreen('tab'); }

  const inThread = view === 'workspace' && screen === 'tab';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--color-base)' }}>
      <header style={{ height: 'calc(50px + env(safe-area-inset-top))', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', paddingTop: 'env(safe-area-inset-top)', background: 'var(--color-pane)', borderBottom: '1px solid var(--color-border)' }}>
        {inThread ? (
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
        {view === 'agents' ? (
          <AgentsView />
        ) : screen === 'list' ? (
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}><ProjectSidebar onSelectTab={openTab} /></div>
        ) : activeTab ? (
          <TabHost key={activeTab} terminalId={activeTab} />
        ) : (
          <div style={{ padding: 16, color: 'var(--color-text-secondary)' }}>No thread open</div>
        )}
      </div>

      <nav style={{ flexShrink: 0, display: 'flex', borderTop: '1px solid var(--color-border)', background: 'var(--color-pane)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {(['workspace', 'agents'] as const).map((v) => (
          <button key={v} onClick={() => { setView(v); if (v === 'workspace') setScreen('list'); }}
            style={{ flex: 1, height: 52, background: 'none', border: 'none', color: view === v ? 'var(--color-accent)' : 'var(--color-text-secondary)', fontSize: 12.5, fontWeight: view === v ? 600 : 400, cursor: 'pointer' }}>
            {v === 'workspace' ? 'Projects' : 'Agents'}
          </button>
        ))}
      </nav>
    </div>
  );
}
