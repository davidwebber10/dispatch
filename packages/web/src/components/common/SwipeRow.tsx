import { useRef, useState } from 'react';

// Mobile-only iOS-style swipe row: drag the content left to reveal a single
// action button (Delete / Unpin) behind its right edge. Disabled on desktop,
// where it renders children untouched. The opaque foreground (base bg) hides the
// action when closed; we lock onto the horizontal axis only once the finger
// commits to it so vertical list-scrolling still works, and swallow the tap that
// ends a swipe so it never falls through to the row's navigation.
//
// Like iOS Mail: a slow drag just reveals the button (tap to act); but a far
// drag (past ~half the row) or a fast left flick fires the action directly. The
// action button stretches to meet the dragged edge so there's never a gap.
export function SwipeRow({ actionLabel, actionColor, onAction, disabled, children }: { actionLabel: string; actionColor: string; onAction: () => void; disabled?: boolean; children: React.ReactNode }) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dxRef = useRef(0);
  const startX = useRef(0);
  const startY = useRef(0);
  const startDx = useRef(0);
  const axis = useRef<'x' | 'y' | null>(null);
  const moved = useRef(false);
  const openRef = useRef(false);
  const width = useRef(0);
  const lastX = useRef(0);
  const lastT = useRef(0);
  const vx = useRef(0); // px/ms, negative = leftward
  const REVEAL = 84;

  if (disabled) return <>{children}</>;

  const set = (v: number) => { dxRef.current = v; setDx(v); };
  const onStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    startX.current = t.clientX; startY.current = t.clientY; startDx.current = dxRef.current;
    width.current = (e.currentTarget as HTMLElement).offsetWidth;
    lastX.current = t.clientX; lastT.current = Date.now(); vx.current = 0;
    axis.current = null; moved.current = false; setDragging(true);
  };
  const onMove = (e: React.TouchEvent) => {
    const t = e.touches[0];
    const ddx = t.clientX - startX.current;
    const ddy = t.clientY - startY.current;
    if (axis.current === null && (Math.abs(ddx) > 8 || Math.abs(ddy) > 8)) {
      axis.current = Math.abs(ddx) > Math.abs(ddy) ? 'x' : 'y';
    }
    if (axis.current !== 'x') return;
    moved.current = true;
    const now = Date.now();
    const dt = now - lastT.current;
    if (dt > 0) vx.current = (t.clientX - lastX.current) / dt;
    lastX.current = t.clientX; lastT.current = now;
    const cap = width.current ? width.current * 0.95 : REVEAL + 24;
    set(Math.max(-cap, Math.min(0, startDx.current + ddx)));
  };
  const onEnd = () => {
    setDragging(false);
    if (axis.current !== 'x') return;
    const farEnough = dxRef.current < -(width.current * 0.5);
    const fastFlick = vx.current < -0.6 && dxRef.current < -REVEAL / 2;
    if (farEnough || fastFlick) {
      set(0); openRef.current = false;
      onAction();
      return;
    }
    const open = dxRef.current < -REVEAL / 2;
    set(open ? -REVEAL : 0);
    openRef.current = open;
  };
  const onClickCapture = (e: React.MouseEvent) => {
    if (moved.current || openRef.current) {
      e.preventDefault(); e.stopPropagation();
      if (openRef.current && !moved.current) { set(0); openRef.current = false; }
      moved.current = false;
    }
  };
  return (
    <div style={{ position: 'relative', overflow: 'hidden' }}>
      <button onClick={() => { set(0); openRef.current = false; onAction(); }}
        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: Math.max(REVEAL, -dx), display: 'flex', alignItems: 'center', justifyContent: 'center', background: actionColor, color: '#fff', border: 'none', font: '600 13px var(--font-sans)', cursor: 'pointer' }}>
        {actionLabel}
      </button>
      <div onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd} onClickCapture={onClickCapture}
        style={{ position: 'relative', transform: `translateX(${dx}px)`, transition: dragging ? 'none' : 'transform .22s cubic-bezier(.4,0,.2,1)', background: 'var(--color-base)', touchAction: 'pan-y' }}>
        {children}
      </div>
    </div>
  );
}
