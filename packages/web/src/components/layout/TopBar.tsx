import { useState } from 'react';
import { Gear } from '@phosphor-icons/react';
import { ConnectionStatus } from './ConnectionStatus';
import { BrandSwitcher } from './BrandSwitcher';
import { SettingsModal } from '../settings/SettingsModal';

export function TopBar() {
  const [settings, setSettings] = useState(false);
  return (
    <header style={{
      height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12,
      padding: '0 12px', background: 'var(--color-pane)', borderBottom: '1px solid var(--color-border)',
    }}>
      <BrandSwitcher />
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
