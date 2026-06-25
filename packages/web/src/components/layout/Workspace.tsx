import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useUI } from '../../stores/ui';

const SKEY = 'dispatch:sidebar-width';
const IKEY = 'dispatch:inspector-width';
const S_MIN = 180, S_MAX = 520, S_DEF = 260;
const I_MIN = 220, I_MAX = 600, I_DEF = 320;
// Dragging a handle below this width (well under the min) collapses that column.
const S_COLLAPSE = 110, I_COLLAPSE = 150;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function load(key: string, def: number, lo: number, hi: number): number {
  try {
    const v = parseInt(localStorage.getItem(key) || '', 10);
    if (!isNaN(v) && v >= lo && v <= hi) return v;
  } catch { /* ignore */ }
  return def;
}

function DragHandle({ onStart }: { onStart: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseDown={(e) => { e.preventDefault(); onStart(); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role="separator"
      aria-orientation="vertical"
      style={{ width: 4, cursor: 'col-resize', background: hover ? 'rgba(62,207,106,0.45)' : 'transparent', flexShrink: 0, transition: 'background 0.15s ease', zIndex: 10 }}
    />
  );
}

export function Workspace({ sidebar, main, inspector }: { sidebar: ReactNode; main: ReactNode; inspector: ReactNode }) {
  const [sideW, setSideW] = useState(() => load(SKEY, S_DEF, S_MIN, S_MAX));
  const [inspW, setInspW] = useState(() => load(IKEY, I_DEF, I_MIN, I_MAX));
  const dragging = useRef<null | 'left' | 'right'>(null);
  const leftCollapsed = useUI((s) => s.leftCollapsed);
  const rightCollapsed = useUI((s) => s.rightCollapsed);

  useEffect(() => { try { localStorage.setItem(SKEY, String(sideW)); } catch { /* */ } }, [sideW]);
  useEffect(() => { try { localStorage.setItem(IKEY, String(inspW)); } catch { /* */ } }, [inspW]);

  useEffect(() => {
    function endDrag() {
      if (!dragging.current) return;
      dragging.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    function onMove(e: MouseEvent) {
      if (dragging.current === 'left') {
        if (e.clientX < S_COLLAPSE) { useUI.getState().setLeftCollapsed(true); endDrag(); return; }
        setSideW(clamp(e.clientX, S_MIN, S_MAX));
      } else if (dragging.current === 'right') {
        const w = window.innerWidth - e.clientX;
        if (w < I_COLLAPSE) { useUI.getState().setRightCollapsed(true); endDrag(); return; }
        setInspW(clamp(w, I_MIN, I_MAX));
      }
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', endDrag);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', endDrag); };
  }, []);

  function start(which: 'left' | 'right') {
    dragging.current = which;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  return (
    <div style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0 }}>
      <aside style={{ width: leftCollapsed ? 0 : sideW, flexShrink: 0, background: 'var(--color-pane)', borderRight: leftCollapsed ? 'none' : '1px solid var(--color-border)', overflow: leftCollapsed ? 'hidden' : 'auto' }}>{sidebar}</aside>
      {!leftCollapsed && <DragHandle onStart={() => start('left')} />}
      <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>{main}</main>
      {!rightCollapsed && <DragHandle onStart={() => start('right')} />}
      <aside style={{ width: rightCollapsed ? 0 : inspW, flexShrink: 0, background: 'var(--color-pane)', borderLeft: rightCollapsed ? 'none' : '1px solid var(--color-border)', overflow: rightCollapsed ? 'hidden' : 'auto' }}>{inspector}</aside>
    </div>
  );
}
