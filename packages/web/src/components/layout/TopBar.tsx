import { useState } from 'react';
import { Gear, Sidebar } from '@phosphor-icons/react';
import { ConnectionStatus } from './ConnectionStatus';
import { BrandSwitcher } from './BrandSwitcher';
import { SettingsModal } from '../settings/SettingsModal';
import { useUI } from '../../stores/ui';

const iconBtn: React.CSSProperties = {
  width: 28, height: 28, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
  borderRadius: 7, background: 'var(--color-elevated)', border: '1px solid #2C2C32', cursor: 'pointer',
};

export function TopBar() {
  const [settings, setSettings] = useState(false);
  const leftCollapsed = useUI((s) => s.leftCollapsed);
  const rightCollapsed = useUI((s) => s.rightCollapsed);
  const toggleLeft = useUI((s) => s.toggleLeft);
  const toggleRight = useUI((s) => s.toggleRight);

  return (
    <header style={{
      position: 'relative', height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12,
      padding: '0 12px', background: 'var(--color-pane)', borderBottom: '1px solid var(--color-border)',
    }}>
      <button title={leftCollapsed ? 'Show projects panel' : 'Hide projects panel'} onClick={toggleLeft}
        style={{ ...iconBtn, color: leftCollapsed ? 'var(--color-text-secondary)' : 'var(--color-text-primary)' }}>
        <Sidebar size={16} weight={leftCollapsed ? 'regular' : 'fill'} />
      </button>
      <BrandSwitcher />
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        <ConnectionStatus />
        <button title="Settings" onClick={() => setSettings(true)} style={{ ...iconBtn, color: 'var(--color-text-secondary)' }}>
          <Gear size={16} />
        </button>
        <button title={rightCollapsed ? 'Show details panel' : 'Hide details panel'} onClick={toggleRight}
          style={{ ...iconBtn, color: rightCollapsed ? 'var(--color-text-secondary)' : 'var(--color-text-primary)' }}>
          <Sidebar size={16} weight={rightCollapsed ? 'regular' : 'fill'} style={{ transform: 'scaleX(-1)' }} />
        </button>
      </div>
      <SettingsModal open={settings} onClose={() => setSettings(false)} />
    </header>
  );
}
