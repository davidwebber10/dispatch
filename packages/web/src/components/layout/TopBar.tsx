import { useState } from 'react';
import { Gear } from '@phosphor-icons/react';
import { ConnectionStatus } from './ConnectionStatus';
import { BrandSwitcher } from './BrandSwitcher';
import { SettingsModal } from '../settings/SettingsModal';
import { useUI, type View } from '../../stores/ui';

const LABELS: Record<View, string> = { workspace: 'Projects', agents: 'Agents' };

export function TopBar() {
  const view = useUI((s) => s.view);
  const setView = useUI((s) => s.setView);
  const [settings, setSettings] = useState(false);
  return (
    <header style={{
      height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12,
      padding: '0 12px', background: 'var(--color-pane)', borderBottom: '1px solid var(--color-border)',
    }}>
      <BrandSwitcher />
      <div style={{ display: 'inline-flex', marginLeft: 8, background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, padding: 3 }}>
        {(['workspace', 'agents'] as const).map((v) => (
          <button key={v} onClick={() => setView(v)} style={{
            padding: '4px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12.5,
            background: view === v ? 'var(--color-accent)' : 'transparent',
            color: view === v ? '#08240F' : 'var(--color-text-secondary)', fontWeight: view === v ? 600 : 400,
          }}>{LABELS[v]}</button>
        ))}
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        <ConnectionStatus />
        <button title="Settings" onClick={() => setSettings(true)} style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, background: 'var(--color-elevated)', border: '1px solid #2C2C32', color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
          <Gear size={16} />
        </button>
      </div>
      <SettingsModal open={settings} onClose={() => setSettings(false)} />
    </header>
  );
}
