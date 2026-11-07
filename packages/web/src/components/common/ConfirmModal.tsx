import type React from 'react';
import { createPortal } from 'react-dom';

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
  if (!open) return null;
  return createPortal(
    <div onClick={onCancel} style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'var(--color-overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="alertdialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} style={{ width: 380, maxWidth: '100%', background: 'var(--color-modal)', border: '1px solid var(--color-border-hover)', borderRadius: 'var(--radius-xl)', boxShadow: '0 30px 80px -20px var(--color-shadow-strong)', overflow: 'hidden' }}>
        <div style={{ padding: '18px 20px 6px', fontSize: 16, fontWeight: 600 }}>{title}</div>
        <div style={{ padding: '0 20px 18px', fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>{message}{children}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 20px', borderTop: '1px solid var(--color-hover)' }}>
          <button onClick={onCancel} style={{ height: 34, padding: '0 16px', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-secondary)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button onClick={onConfirm} style={{ height: 34, padding: '0 18px', background: danger ? 'var(--color-status-red)' : 'var(--color-accent)', border: 'none', borderRadius: 'var(--radius-md)', color: danger ? 'var(--color-on-danger)' : 'var(--color-on-accent)', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
