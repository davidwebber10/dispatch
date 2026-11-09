import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { focusableIn, isTopLayer, pushLayer, useLayerOrder } from './layers';
import './ui.css';

/**
 * What every dialog does with the keyboard (Modal, ConfirmModal):
 *   - focus moves into the dialog when it opens (a field with `autoFocus` keeps it; otherwise the
 *     panel itself takes it, so a phone does not open its keyboard and no button looks picked);
 *   - Tab stays inside: from the last control it goes to the first, and back;
 *   - Escape closes it, when it is the layer on top and nothing inside handled the key first;
 *   - focus returns to the control that opened it, unless the app has put focus somewhere itself.
 * The panel needs `tabIndex={-1}`.
 */
export function useDialogFocus(open: boolean, panelRef: RefObject<HTMLElement | null>, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const order = useLayerOrder(open);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const id = Symbol('dialog');
    const pop = pushLayer(id, order.current ?? undefined);
    const opener = document.activeElement instanceof HTMLElement && !panel.contains(document.activeElement) ? document.activeElement : null;
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (!isTopLayer(id)) return;
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return;
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || e.defaultPrevented) return;
      const items = focusableIn(panel);
      const active = document.activeElement as HTMLElement | null;
      if (items.length === 0) { e.preventDefault(); panel.focus({ preventScroll: true }); return; }
      const first = items[0], last = items[items.length - 1];
      const inside = !!active && panel.contains(active) && active !== panel;
      if (e.shiftKey) {
        if (!inside || active === first) { e.preventDefault(); last.focus(); }
      } else if (!inside || active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      pop();
      // The panel is gone, so focus fell to the body (or is still in the panel when a closed Modal
      // stays mounted). If the app focused something else on its way out, leave it there.
      const now = document.activeElement;
      const lost = !now || now === document.body || panel.contains(now) || !now.isConnected;
      if (lost && opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
