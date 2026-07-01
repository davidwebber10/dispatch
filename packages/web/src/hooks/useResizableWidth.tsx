import { useEffect, useRef, useState } from 'react';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function load(key: string, def: number, lo: number, hi: number): number {
  try {
    const v = parseInt(localStorage.getItem(key) || '', 10);
    if (!isNaN(v) && v >= lo && v <= hi) return v;
  } catch { /* ignore */ }
  return def;
}

/**
 * Drag-to-resize a panel's width, persisted to localStorage under `key`. `edge` picks
 * which side of the pointer position the width tracks: 'left' for a panel anchored to
 * the left of the viewport (width == clientX), 'right' for one anchored to the right
 * (width == distance from clientX to the viewport's right edge).
 *
 * `collapseBelow`/`onCollapse` are optional: when set, dragging past that threshold
 * (well under `lo`) fires `onCollapse` and ends the drag instead of clamping to `lo`.
 */
export function useResizableWidth({
  key,
  def,
  lo,
  hi,
  edge,
  collapseBelow,
  onCollapse,
}: {
  key: string;
  def: number;
  lo: number;
  hi: number;
  edge: 'left' | 'right';
  collapseBelow?: number;
  onCollapse?: () => void;
}) {
  const [width, setWidth] = useState(() => load(key, def, lo, hi));
  const dragging = useRef(false);

  useEffect(() => { try { localStorage.setItem(key, String(width)); } catch { /* */ } }, [key, width]);

  useEffect(() => {
    function endDrag() {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    function onMove(e: MouseEvent) {
      if (!dragging.current) return;
      const raw = edge === 'left' ? e.clientX : window.innerWidth - e.clientX;
      if (collapseBelow !== undefined && raw < collapseBelow) {
        onCollapse?.();
        endDrag();
        return;
      }
      setWidth(clamp(raw, lo, hi));
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', endDrag);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', endDrag); };
  }, [edge, lo, hi, collapseBelow, onCollapse]);

  function startDrag() {
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  return { width, startDrag };
}

export function DragHandle({ onStart }: { onStart: () => void }) {
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
