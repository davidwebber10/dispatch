import type { ReactNode } from 'react';
import { useUI } from '../../stores/ui';
import { DragHandle, useResizableWidth } from '../../hooks/useResizableWidth';

const SKEY = 'dispatch:sidebar-width';
const IKEY = 'dispatch:inspector-width';
const S_MIN = 180, S_MAX = 520, S_DEF = 260;
const I_MIN = 300, I_MAX = 600, I_DEF = 320;
// Dragging a handle below this width (well under the min) collapses that column.
const S_COLLAPSE = 110, I_COLLAPSE = 150;

export function Workspace({ sidebar, main, inspector }: { sidebar: ReactNode; main: ReactNode; inspector: ReactNode }) {
  const leftCollapsed = useUI((s) => s.leftCollapsed);
  const rightCollapsed = useUI((s) => s.rightCollapsed);
  const { width: sideW, startDrag: startLeftDrag } = useResizableWidth({
    key: SKEY, def: S_DEF, lo: S_MIN, hi: S_MAX, edge: 'left',
    collapseBelow: S_COLLAPSE, onCollapse: () => useUI.getState().setLeftCollapsed(true),
  });
  const { width: inspW, startDrag: startRightDrag } = useResizableWidth({
    key: IKEY, def: I_DEF, lo: I_MIN, hi: I_MAX, edge: 'right',
    collapseBelow: I_COLLAPSE, onCollapse: () => useUI.getState().setRightCollapsed(true),
  });

  return (
    <div style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0 }}>
      <aside style={{ width: leftCollapsed ? 0 : sideW, flexShrink: 0, background: 'var(--color-pane)', borderRight: leftCollapsed ? 'none' : '1px solid var(--color-border)', overflow: leftCollapsed ? 'hidden' : 'auto' }}>{sidebar}</aside>
      {!leftCollapsed && <DragHandle onStart={startLeftDrag} />}
      <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>{main}</main>
      {/* No inspector content (e.g. the Dispatch coordinator tab) → skip the pane and its
          handle entirely, so `main` reclaims the width instead of framing an empty pane. */}
      {inspector && !rightCollapsed && <DragHandle onStart={startRightDrag} />}
      {inspector && (
        <aside style={{ width: rightCollapsed ? 0 : inspW, flexShrink: 0, background: 'var(--color-pane)', borderLeft: rightCollapsed ? 'none' : '1px solid var(--color-border)', overflow: rightCollapsed ? 'hidden' : 'auto' }}>{inspector}</aside>
      )}
    </div>
  );
}
