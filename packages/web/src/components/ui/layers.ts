import { useRef } from 'react';

// The stack of open layers (a dialog, a popover, a menu). Escape and the Tab trap belong to the
// layer on top only, so Escape in a menu inside a dialog closes the menu and leaves the dialog.
//
// The order is the order in which the layers were RENDERED open, not the order of their effects: a
// dialog that renders another open dialog inside it runs the inner effect first, and the inner one
// must still be on top. `nextLayerOrder()` is taken during render (parent before child).
const stack = new Map<symbol, number>();
let counter = 0;

export const nextLayerOrder = (): number => ++counter;

/** Put a layer in the stack. Returns the function that takes it off. */
export function pushLayer(id: symbol, order: number = nextLayerOrder()): () => void {
  stack.set(id, order);
  return () => { stack.delete(id); };
}

export function isTopLayer(id: symbol): boolean {
  const mine = stack.get(id);
  if (mine === undefined) return false;
  for (const order of stack.values()) if (order > mine) return false;
  return true;
}

/** The layer's place in the stack: taken in the render that opens it, dropped when it closes. */
export function useLayerOrder(open: boolean): { current: number | null } {
  const ref = useRef<number | null>(null);
  if (open && ref.current === null) ref.current = nextLayerOrder();
  if (!open) ref.current = null;
  return ref;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), [role="combobox"]:not([aria-disabled="true"]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/** The controls in `root` that Tab can reach, in document order. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if (el.tabIndex < 0 || el.hasAttribute('inert') || el.closest('[inert]')) return false;
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    return !style || (style.display !== 'none' && style.visibility !== 'hidden');
  });
}
