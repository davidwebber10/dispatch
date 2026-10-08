import { useState } from 'react';
import { Sidebar } from '@phosphor-icons/react';
import { useUI } from '../../stores/ui';

/**
 * The projects/details panel collapse toggles. They sit at the two ENDS of the
 * workspace's top strip (flanking the tab bar) — the same top-left/top-right
 * spots the old TopBar gave them — and stay visible when their panel is
 * collapsed, because a toggle that collapses away with its panel can never
 * bring it back.
 *
 * `count` (the Control Plane's open decisions, pinned card spec 2026-10-08, Unit 7) shows on
 * the toggle while its panel is collapsed, so the decisions on the hidden card stay in sight.
 */
export function PanelToggle({ side, count = 0 }: { side: 'left' | 'right'; count?: number }) {
  const collapsed = useUI((s) => (side === 'left' ? s.leftCollapsed : s.rightCollapsed));
  const [hover, setHover] = useState(false);
  const badge = collapsed && count > 0;
  const label = side === 'left'
    ? (collapsed ? 'Show projects panel' : 'Hide projects panel')
    : (collapsed ? 'Show details panel' : 'Hide details panel');
  const title = badge ? `${label} (${count} open decision${count === 1 ? '' : 's'})` : label;
  return (
    <button type="button" title={title} aria-label={title}
      onClick={() => (side === 'left' ? useUI.getState().toggleLeft() : useUI.getState().toggleRight())}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        width: 38, height: 44, flexShrink: 0, border: 'none', cursor: 'pointer', padding: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
        background: hover ? 'var(--color-elevated)' : 'var(--color-pane)',
        borderBottom: '1px solid var(--color-border)',
        color: collapsed ? 'var(--color-text-secondary)' : 'var(--color-text-primary)',
      }}>
      <Sidebar size={16} weight={collapsed ? 'regular' : 'fill'}
        style={side === 'right' ? { transform: 'scaleX(-1)' } : undefined} />
      {badge && (
        <span data-testid="panel-toggle-count" style={{
          position: 'absolute', top: 6, right: 3, minWidth: 14, height: 14, padding: '0 3px', borderRadius: 7,
          background: 'var(--color-status-yellow)', color: 'var(--color-pane)',
          font: '700 9.5px var(--font-mono)', lineHeight: '14px', textAlign: 'center',
        }}>{count}</span>
      )}
    </button>
  );
}
