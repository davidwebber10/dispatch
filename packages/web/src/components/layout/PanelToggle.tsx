import { useState } from 'react';
import { Sidebar } from '@phosphor-icons/react';
import { useUI } from '../../stores/ui';

/**
 * The projects/details panel collapse toggles. They sit at the two ENDS of the
 * workspace's top strip (flanking the tab bar) — the same top-left/top-right
 * spots the old TopBar gave them — and stay visible when their panel is
 * collapsed, because a toggle that collapses away with its panel can never
 * bring it back.
 */
export function PanelToggle({ side }: { side: 'left' | 'right' }) {
  const collapsed = useUI((s) => (side === 'left' ? s.leftCollapsed : s.rightCollapsed));
  const [hover, setHover] = useState(false);
  const label = side === 'left'
    ? (collapsed ? 'Show projects panel' : 'Hide projects panel')
    : (collapsed ? 'Show details panel' : 'Hide details panel');
  return (
    <button type="button" title={label} aria-label={label}
      onClick={() => (side === 'left' ? useUI.getState().toggleLeft() : useUI.getState().toggleRight())}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        width: 38, height: 44, flexShrink: 0, border: 'none', cursor: 'pointer', padding: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: hover ? 'var(--color-elevated)' : 'var(--color-pane)',
        borderBottom: '1px solid var(--color-border)',
        color: collapsed ? 'var(--color-text-secondary)' : 'var(--color-text-primary)',
      }}>
      <Sidebar size={16} weight={collapsed ? 'regular' : 'fill'}
        style={side === 'right' ? { transform: 'scaleX(-1)' } : undefined} />
    </button>
  );
}
