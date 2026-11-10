import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, HTMLAttributes, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { isTopLayer, pushLayer, useLayerOrder } from './layers';
import './ui.css';

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
export type PopoverAnchor = RefObject<HTMLElement | null> | HTMLElement | null;

/** The gap between the anchor and the popover, and the least distance to a window edge. */
const GAP = 6;
const EDGE = 8;

/**
 * Where an anchored box goes: under the anchor (or over it, when asked or when there is no room
 * under it), then moved so that it stays inside the window with an 8px margin. `maxHeight` is the
 * most it may be tall; a longer popover scrolls.
 */
export function placePopover(
  anchor: { left: number; top: number; right: number; bottom: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  placement: Placement = 'bottom-start',
): { left: number; top: number; maxHeight: number } {
  const maxHeight = Math.max(0, viewport.height - EDGE * 2);
  const height = Math.min(size.height, maxHeight);
  const roomBelow = viewport.height - EDGE - (anchor.bottom + GAP);
  const roomAbove = anchor.top - GAP - EDGE;
  const wantTop = placement.startsWith('top');
  const above = wantTop ? (height <= roomAbove || roomAbove >= roomBelow) : (height > roomBelow && roomAbove > roomBelow);
  let top = above ? anchor.top - GAP - height : anchor.bottom + GAP;
  let left = placement.endsWith('end') ? anchor.right - size.width : anchor.left;
  left = Math.max(EDGE, Math.min(left, viewport.width - EDGE - size.width));
  top = Math.max(EDGE, Math.min(top, viewport.height - EDGE - height));
  return { left, top, maxHeight };
}

export const anchorElement = (a: PopoverAnchor): HTMLElement | null => (a && 'current' in a ? a.current : a);

export type PopoverProps = {
  open: boolean;
  onClose: () => void;
  /** The control that the popover hangs from (a ref or the element). */
  anchor: PopoverAnchor;
  placement?: Placement;
  /** The accessible name. */
  label?: string;
  /** `dialog` for free content (the default); Menu passes `menu`. */
  role?: string;
  /** Focus goes back to the anchor when Escape closes it (default true). */
  returnFocus?: boolean;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'role'>;

/**
 * A box anchored to a control: it closes on Escape and on a press outside it, stays inside the
 * window, follows a resize or a scroll, and sits on the dropdown layer (`--z-dropdown`), so it
 * opens above the dialog that holds its anchor.
 */
export const Popover = forwardRef<HTMLDivElement, PopoverProps>(function Popover(
  { open, onClose, anchor, placement = 'bottom-start', label, role = 'dialog', returnFocus = true, className, style, children, ...rest }, outerRef,
) {
  const ref = useRef<HTMLDivElement | null>(null);
  const setRef = (el: HTMLDivElement | null) => {
    ref.current = el;
    if (typeof outerRef === 'function') outerRef(el); else if (outerRef) outerRef.current = el;
  };
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const order = useLayerOrder(open);

  const place = useCallback(() => {
    const el = ref.current, a = anchorElement(anchor);
    if (!el || !a) return;
    const next = placePopover(a.getBoundingClientRect(), { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, placement);
    setPos((p) => (p && p.left === next.left && p.top === next.top && p.maxHeight === next.maxHeight ? p : next));
  }, [anchor, placement]);

  // Measure before the browser paints, so the popover never shows in the wrong place first.
  useLayoutEffect(() => { if (open) place(); else setPos(null); }, [open, place, children]);

  useEffect(() => {
    if (!open) return;
    const id = Symbol('popover');
    const pop = pushLayer(id, order.current ?? undefined);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !isTopLayer(id)) return;
      e.preventDefault(); // the dialog under it stays open
      closeRef.current();
      if (returnFocus) anchorElement(anchor)?.focus({ preventScroll: true });
    };
    const onDown = (e: Event) => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t) || anchorElement(anchor)?.contains(t)) return;
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      pop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, place, returnFocus]);

  if (!open) return null;
  // Not placed yet: drawn clear, not `visibility: hidden`, so a menu can already give focus to its first item.
  const box: CSSProperties = { ...style, left: pos?.left ?? 0, top: pos?.top ?? 0, maxHeight: pos?.maxHeight, ...(pos ? null : { opacity: 0, pointerEvents: 'none' }) };
  return createPortal(
    <div ref={setRef} role={role} aria-label={label} tabIndex={-1} className={['ui-popover', className ?? ''].filter(Boolean).join(' ')} style={{ position: 'fixed', ...box }} {...rest}>
      {children}
    </div>,
    document.body,
  );
});
