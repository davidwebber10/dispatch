import { useEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Popover, anchorElement, type Placement, type PopoverAnchor } from './Popover';
import './ui.css';

export type MenuItem =
  | { id: string; label: ReactNode; /** A Phosphor icon. */ icon?: ReactNode; onSelect: () => void; disabled?: boolean; /** A destructive action: red. */ danger?: boolean }
  | { separator: true };

export type MenuProps = {
  open: boolean;
  onClose: () => void;
  anchor: PopoverAnchor;
  items: MenuItem[];
  /** The accessible name of the menu ("Thread actions"). */
  label: string;
  placement?: Placement;
};

const isItem = (i: MenuItem): i is Exclude<MenuItem, { separator: true }> => !('separator' in i);

/**
 * A menu of actions anchored to a control. The first item takes focus when it opens; the arrow
 * keys, Home and End move (and wrap, and skip a disabled item); Enter or Space picks; Escape closes
 * and gives focus back to the control; Tab or a press outside closes. A pick closes the menu first,
 * then runs the item.
 */
export function Menu({ open, onClose, anchor, items, label, placement }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const buttons = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
  const focusAt = (i: number) => {
    const list = buttons();
    if (list.length === 0) return;
    const next = list[(i + list.length) % list.length];
    for (const b of ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []) b.tabIndex = b === next ? 0 : -1;
    next.focus({ preventScroll: true });
  };

  useEffect(() => { if (open) focusAt(0); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = buttons();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(at + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(at < 0 ? list.length - 1 : at - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAt(list.length - 1); }
    else if (e.key === 'Tab') { onClose(); }
  };

  // Focus goes back to the control first, so what the item opens (a dialog) returns focus there too.
  const pick = (run: () => void) => { anchorElement(anchor)?.focus({ preventScroll: true }); onClose(); run(); };

  const firstEnabled = items.findIndex((i) => isItem(i) && !i.disabled);
  return (
    <Popover ref={ref} open={open} onClose={onClose} anchor={anchor} placement={placement} role="menu" label={label} className="ui-menu" onKeyDown={onKeyDown}>
      {items.map((item, i) => isItem(item) ? (
        <button key={item.id} type="button" role="menuitem" tabIndex={i === firstEnabled ? 0 : -1} disabled={item.disabled}
          className={['ui-menu__item', item.danger ? 'ui-menu__item--danger' : ''].filter(Boolean).join(' ')}
          onClick={() => pick(item.onSelect)}>
          {item.icon !== undefined && item.icon !== null && <span className="ui-menu__icon" aria-hidden="true">{item.icon}</span>}
          <span>{item.label}</span>
        </button>
      ) : <div key={`sep-${i}`} role="separator" className="ui-menu__separator" />)}
    </Popover>
  );
}
