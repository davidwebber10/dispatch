import type React from 'react';
import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui/Button';
import { useDialogFocus } from '../ui/useDialogFocus';
import { fontVar } from '../../lib/fontSize';

/**
 * The app's "are you sure" dialog. It sits on the `--z-modal` layer, above a Modal and its menus.
 * Keyboard (ui/useDialogFocus): focus moves into it, Tab stays between its buttons, Escape cancels,
 * and focus goes back to the control that opened it.
 */
export function ConfirmModal({
  open, title, message, confirmLabel = 'Confirm', danger = false, onConfirm, onCancel, children,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Extra content under the message, e.g. an option the confirm applies. */
  children?: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const messageId = useId();
  useDialogFocus(open, panelRef, onCancel);
  if (!open) return null;
  return createPortal(
    <div onClick={onCancel} style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-modal)', background: 'var(--color-overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div ref={panelRef} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId} tabIndex={-1} className="ui-dialog" onClick={(e) => e.stopPropagation()} style={{ width: 380, maxWidth: '100%', background: 'var(--color-modal)', border: '1px solid var(--color-border-hover)', borderRadius: 'var(--radius-xl)', boxShadow: '0 30px 80px -20px var(--color-shadow-strong)', overflow: 'hidden' }}>
        <div id={titleId} style={{ padding: '18px 20px 6px', fontSize: fontVar(16), fontWeight: 600 }}>{title}</div>
        <div id={messageId} style={{ padding: '0 20px 18px', fontSize: fontVar(13), color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>{message}{children}</div>
        <div className="ui-dialog-actions" style={{ padding: '12px 20px', borderTop: '1px solid var(--color-hover)' }}>
          <Button variant="secondary" size="md" onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} size="md" onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
