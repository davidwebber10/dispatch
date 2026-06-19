import { useEffect, useRef, useState, type ReactNode } from 'react';

const SKEY = 'dispatch:sidebar-width';
const IKEY = 'dispatch:inspector-width';
const S_MIN = 180, S_MAX = 520, S_DEF = 260;
const I_MIN = 220, I_MAX = 600, I_DEF = 320;

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

  useEffect(() => { try { localStorage.setItem(SKEY, String(sideW)); } catch { /* */ } }, [sideW]);
  useEffect(() => { try { localStorage.setItem(IKEY, String(inspW)); } catch { /* */ } }, [inspW]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (dragging.current === 'left') setSideW(clamp(e.clientX, S_MIN, S_MAX));
      else if (dragging.current === 'right') setInspW(clamp(window.innerWidth - e.clientX, I_MIN, I_MAX));
    }
    function onUp() {
      if (!dragging.current) return;
      dragging.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  function start(which: 'left' | 'right') {
    dragging.current = which;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <aside style={{ width: sideW, flexShrink: 0, background: 'var(--color-pane)', borderRight: '1px solid var(--color-border)', overflow: 'auto' }}>{sidebar}</aside>
      <DragHandle onStart={() => start('left')} />
      <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>{main}</main>
      <DragHandle onStart={() => start('right')} />
      <aside style={{ width: inspW, flexShrink: 0, background: 'var(--color-pane)', borderLeft: '1px solid var(--color-border)', overflow: 'auto' }}>{inspector}</aside>
    </div>
  );
}
