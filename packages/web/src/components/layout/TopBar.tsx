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

// The Threads ⇄ Board mode switch. It lives here rather than inside the board because it
// has to work in BOTH directions: a switch that only renders once you are already in board
// mode can get you out but never in, which would leave the board unreachable.
const segBtn = (on: boolean): React.CSSProperties => ({
  padding: '3px 10px', borderRadius: 5, border: 'none', cursor: 'pointer',
  font: `${on ? 600 : 400} 12px var(--font-sans)`,
  background: on ? 'var(--color-accent)' : 'transparent',
  color: on ? '#08240F' : 'var(--color-text-secondary)',
});

export function TopBar() {
  const [settings, setSettings] = useState(false);
  const leftCollapsed = useUI((s) => s.leftCollapsed);
  const rightCollapsed = useUI((s) => s.rightCollapsed);
  const toggleLeft = useUI((s) => s.toggleLeft);
  const toggleRight = useUI((s) => s.toggleRight);
  const view = useUI((s) => s.view);
  const setView = useUI((s) => s.setView);

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
      <div style={{ display: 'inline-flex', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, padding: 2, gap: 2 }}>
        <button type="button" aria-pressed={view === 'workspace'} onClick={() => setView('workspace')} style={segBtn(view === 'workspace')}>
          Threads
        </button>
        <button type="button" aria-pressed={view === 'board'} onClick={() => setView('board')} style={segBtn(view === 'board')}>
          Board
        </button>
      </div>
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
