import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

// A release past this share of the sheet's height closes it; so does a quick downward flick.
const CLOSE_FRACTION = 0.25;
const FLICK_PX_PER_MS = 0.5;
const FLICK_MIN_PX = 12;
const FLICK_MAX_AGE_MS = 100;

/**
 * The shared dialog shell.
 *
 * `title` is optional: a panel that IS the control (the New Thread picker) reads better
 * without a heading. `sheet` anchors the panel to the bottom of the viewport as a phone
 * sheet — rounded top corners, a drag handle, safe-area padding — instead of a floating
 * card; callers switch it on with `useIsMobile()`.
 *
 * A sheet must always be closable on a phone, where there is no Escape key and a tall
 * list can fill the screen. It has three exits: a Close button in the header, a drag or
 * flick down on the header (handle and title), and a dimmed strip above it that stays
 * tappable. The body never starts a drag, so a scrolling list scrolls instead of closing.
 */
export function Modal({ open, onClose, title, sheet = false, closeButton = true, anchor = 'center', maxWidth = 500, children }: {
  open: boolean;
  onClose: () => void;
  title?: string;
  sheet?: boolean;
  /** A sheet's header carries a Close button. A caller with its own (the doc viewer) turns it off. */
  closeButton?: boolean;
  /**
   * `center` floats the card mid-viewport. `top` pins its top edge a fixed way down,
   * so a panel whose height changes with its own state (the New Thread picker: a
   * shell has no mode/model rows, a harness may have no history) grows and shrinks
   * from the bottom instead of jumping to a new centre on every click. Ignored for a
   * sheet, which is always bottom-anchored (and so always dragged down to close).
   */
  anchor?: 'center' | 'top';
  /** The card's widest size (not the sheet's). A reader (the doc viewer) needs more than a form. */
  maxWidth?: number;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // dy is the live drag offset (always >= 0). `drag` holds the gesture's bookkeeping.
  const [dy, setDy] = useState(0);
  const [dragging, setDragging] = useState(false);
  // A tall sheet scrolled up: its header pins to the very top of the screen (2026-11-06). Pinned
  // below the backdrop's dimmed strip instead, the list scrolled on through that strip, visible
  // above the handle. Stuck = the panel's top has gone past the header's.
  const headerRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  const onBackdropScroll = () => {
    const p = panelRef.current, h = headerRef.current;
    setStuck(!!p && !!h && p.getBoundingClientRect().top < h.getBoundingClientRect().top - 0.5);
  };
  const drag = useRef<{ id: number; startY: number; lastY: number; lastT: number; v: number } | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  // The latest onClose, for the touch listeners below (added once per open).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  /** A drag (handle or pulled content) has ended: close on a long pull or a fresh flick, else spring back. */
  const release = (dist: number, v: number, lastT: number, ended: boolean) => {
    // Capped at the screen: 25% of a 2000px list would be farther than a thumb can drag.
    const height = Math.min(panelRef.current?.offsetHeight ?? 0, window.innerHeight || Infinity);
    // A pause before release drops the flick: the speed must be fresh.
    const fresh = performance.now() - lastT <= FLICK_MAX_AGE_MS;
    const flick = ended && fresh && v > FLICK_PX_PER_MS && dist >= FLICK_MIN_PX;
    if (ended && (flick || (height > 0 && dist > height * CLOSE_FRACTION))) { closeRef.current(); return; }
    setDy(0); // spring back
  };

  // Pull to close (2026-11-06): with the sheet scrolled all the way up, carrying on downward moves
  // the sheet itself, as on iOS, and lets go the same way the handle does. Touch only (a mouse has
  // the handle and Escape). Not from the header (it has its own drag), and not while an inner list
  // under the finger can still scroll up.
  useEffect(() => {
    const el = backdropRef.current;
    if (!open || !sheet || !el) return;
    let pulling = false, armed = false, startY = 0, prevY = 0, lastY = 0, lastT = 0, v = 0;
    const innerCanScrollUp = (t: EventTarget | null) => {
      for (let n = t as HTMLElement | null; n && n !== el; n = n.parentElement) {
        if (n.scrollTop > 0 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)) return true;
      }
      return false;
    };
    const onStart = (e: TouchEvent) => {
      pulling = false;
      armed = e.touches.length === 1 && !(e.target as HTMLElement | null)?.closest?.('[data-testid="sheet-header"]');
      prevY = e.touches[0]?.clientY ?? 0;
    };
    const onMove = (e: TouchEvent) => {
      if (!armed || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      const now = performance.now();
      if (!pulling) {
        // Start once the list is at its top and the finger is moving down; a scroll that reaches
        // the top mid-gesture hands over from where it is.
        if (el.scrollTop > 0 || y <= prevY || innerCanScrollUp(e.target)) { prevY = y; return; }
        pulling = true; startY = prevY; lastY = prevY; lastT = now; v = 0;
        setDragging(true);
      }
      if (e.cancelable) e.preventDefault(); // the sheet moves, not the page (no rubber band)
      if (now > lastT) v = (y - lastY) / (now - lastT);
      lastY = y; lastT = now;
      setDy(Math.max(0, y - startY));
    };
    const onEnd = (e: TouchEvent) => {
      armed = false;
      if (!pulling) return;
      pulling = false;
      setDragging(false);
      release(Math.max(0, lastY - startY), v, lastT, e.type === 'touchend');
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sheet]);

  useEffect(() => {
    if (!open || !sheet) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, sheet, onClose]);

  // A closed Modal can stay mounted (Projects, Memory), so a drag-close must not leave
  // its offset behind for the next open.
  useEffect(() => { if (!open) { drag.current = null; setDragging(false); setDy(0); } }, [open]);

  if (!open) return null;

  const onDragStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary || (e.button !== undefined && e.button > 0)) return;
    // A tap on the Close button must stay a tap.
    if ((e.target as HTMLElement).closest('button')) return;
    drag.current = { id: e.pointerId, startY: e.clientY, lastY: e.clientY, lastT: performance.now(), v: 0 };
    setDragging(true);
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer: nothing to capture */ }
  };
  const onDragMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const now = performance.now();
    if (now > d.lastT) d.v = (e.clientY - d.lastY) / (now - d.lastT);
    d.lastY = e.clientY; d.lastT = now;
    setDy(Math.max(0, e.clientY - d.startY));
  };
  const onDragEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    release(Math.max(0, e.clientY - d.startY), d.v, d.lastT, e.type === 'pointerup');
  };

  // Portal to <body>: on mobile this modal's parents (the slide-rail) use a CSS
  // transform, which re-bases position:fixed to the transformed ancestor instead
  // of the viewport — trapping the modal off-screen. Portaling escapes that.
  return createPortal(
    // The BACKDROP scrolls, not the panel, and the panel centres via `margin:auto`.
    // Auto margins on a flex child centre it when there is spare room and top-align
    // it (without clipping, unlike align-items:center) when there is not — so a tall
    // modal opens at the top and scrolls, a short one stays centred. The sheet uses
    // the same trick with `marginTop:auto` only (the cross-axis auto margin of a row
    // flex item), so it sits at the bottom when short and top-aligns (fully
    // scrollable) when tall.
    //
    // The panel deliberately has NO maxHeight: `100dvh` does not shrink for the
    // on-screen keyboard, so clamping to it left the bottom of a tall modal stranded
    // under the keyboard with no overflow left to scroll. A sheet gets its dimmed strip
    // from the backdrop's top padding instead (48px plus the safe area): a tall sheet
    // opens with that strip showing, and its header is sticky so Close and the handle
    // stay in reach once the backdrop has scrolled.
    <div ref={backdropRef} onClick={onClose} onScroll={sheet ? onBackdropScroll : undefined} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex',
      alignItems: 'flex-start', justifyContent: 'center', zIndex: 100,
      overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch',
      padding: sheet
        ? 'calc(48px + env(safe-area-inset-top)) 0 0'
        : anchor === 'top'
          ? 'calc(12vh + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left))'
          : 'calc(16px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left))',
    }}>
      {sheet && <style>{
        '@keyframes dispatch-modal-sheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } }'
        + ' @media (prefers-reduced-motion: reduce) { [data-testid="sheet-panel"] { animation: none !important; transition: none !important; } }'
      }</style>}
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={title} data-testid={sheet ? 'sheet-panel' : undefined} onClick={(e) => e.stopPropagation()} style={sheet ? {
        width: '100%', marginTop: 'auto', flexShrink: 0, boxSizing: 'border-box',
        background: '#18181B', borderTop: '1px solid #2F2F35', borderRadius: 'var(--radius-2xl) var(--radius-2xl) 0 0',
        padding: '0 16px calc(16px + env(safe-area-inset-bottom))',
        display: 'flex', flexDirection: 'column', gap: 14,
        animation: 'dispatch-modal-sheet-up .18s ease-out',
        transform: `translateY(${dy}px)`,
        transition: dragging ? 'none' : 'transform .18s ease-out',
      } : {
        // `auto` top/bottom margins centre; a zero top margin pins the card under the
        // backdrop's top padding so only its bottom edge moves as content changes.
        width: '100%', maxWidth, margin: anchor === 'top' ? '0 auto auto' : 'auto', flexShrink: 0, boxSizing: 'border-box',
        background: '#18181B', border: '1px solid #2F2F35', borderRadius: 'var(--radius-lg)', padding: 20,
        boxShadow: '0 30px 80px -20px rgba(0,0,0,.85)',
      }}>
        {sheet ? (
          // The drag zone: handle plus title row. touch-action:none stops the browser
          // claiming the gesture as a scroll or pull-to-refresh before we see it.
          <div data-testid="sheet-header" ref={headerRef} data-stuck={stuck || undefined}
            onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragEnd} onLostPointerCapture={onDragEnd}
            style={{
              // The top offset cancels the backdrop's top padding (48px + the safe area), which a
              // sticky offset counts from, so a stuck header sits at the screen's top edge; it then
              // pads for the status bar and squares its corners, leaving nothing to show past it.
              position: 'sticky', top: 'calc(-48px - env(safe-area-inset-top))', zIndex: 1, background: '#18181B',
              borderRadius: stuck ? 0 : 'var(--radius-2xl) var(--radius-2xl) 0 0',
              margin: '0 -16px', padding: stuck ? 'calc(8px + env(safe-area-inset-top)) 16px 0' : '8px 16px 0', touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', flex: 'none',
            }}>
            <div data-testid="sheet-handle" aria-hidden="true" style={{ width: 36, height: 4, borderRadius: 'var(--radius-xs)', background: '#3A3A40', margin: '0 auto 2px' }} />
            {(title || closeButton) && <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44 }}>
              {title ? <h2 style={{ margin: 0, flex: 1, minWidth: 0, fontSize: 19, fontWeight: 600 }}>{title}</h2> : <span style={{ flex: 1 }} />}
              {closeButton && <button type="button" aria-label="Close" onClick={onClose} style={{
                minWidth: 44, minHeight: 44, flex: 'none', marginRight: -10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                background: 'transparent', border: 'none', color: '#A1A1AA', fontSize: 22, lineHeight: 1, cursor: 'pointer', borderRadius: 'var(--radius-2xl)',
              }}>×</button>}
            </div>}
          </div>
        ) : title && <h2 style={{ margin: '0 0 16px', fontSize: 19, fontWeight: 600 }}>{title}</h2>}
        {children}
      </div>
    </div>,
    document.body,
  );
}
