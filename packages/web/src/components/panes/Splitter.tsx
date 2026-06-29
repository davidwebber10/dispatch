import { useRef, useState } from 'react';

/** A draggable divider between two panes of a split node.
 *  'row'  -> a 6px vertical grab bar  (col-resize), ratio = left width fraction.
 *  'col'  -> a 6px horizontal grab bar (row-resize), ratio = top height fraction.
 *  Computes the new ratio from the parent split container's rect and reports it
 *  via onRatio (already clamped .15–.85). Uses pointer capture so the drag
 *  survives moving over iframes / xterm canvases. */
export function Splitter({ dir, ratio, onRatio }: { dir: 'row' | 'col'; ratio: number; onRatio: (r: number) => void }) {
  void ratio; // current ratio is reflected by the surrounding flex; kept for API symmetry
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const [hover, setHover] = useState(false);
  const isRow = dir === 'row';

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    setActive(true);

    const move = (ev: PointerEvent) => {
      const rect = parent.getBoundingClientRect();
      const r = isRow
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
      onRatio(Math.max(0.15, Math.min(0.85, r)));
    };
    const up = () => {
      setActive(false);
      try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  const lit = active || hover;
  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      role="separator"
      aria-orientation={isRow ? 'vertical' : 'horizontal'}
      style={{
        flexShrink: 0,
        position: 'relative',
        width: isRow ? 6 : '100%',
        height: isRow ? '100%' : 6,
        cursor: isRow ? 'col-resize' : 'row-resize',
        background: lit ? 'color-mix(in srgb, var(--color-accent) 30%, transparent)' : 'transparent',
        transition: 'background .12s ease',
        touchAction: 'none',
        zIndex: 6,
      }}
    >
      <div
        style={{
          position: 'absolute',
          background: lit ? 'var(--color-accent)' : 'var(--color-border)',
          transition: 'background .12s ease',
          ...(isRow
            ? { top: 0, bottom: 0, left: '50%', width: 1, transform: 'translateX(-0.5px)' }
            : { left: 0, right: 0, top: '50%', height: 1, transform: 'translateY(-0.5px)' }),
        }}
      />
    </div>
  );
}
