import { createPortal } from 'react-dom';

export function ConfirmModal({
  open, title, message, confirmLabel = 'Confirm', danger = false, onConfirm, onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return createPortal(
    <div onClick={onCancel} style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 380, maxWidth: '100%', background: '#18181b', border: '1px solid #2f2f35', borderRadius: 14, boxShadow: '0 30px 80px -20px rgba(0,0,0,.85)', overflow: 'hidden' }}>
        <div style={{ padding: '18px 20px 6px', fontSize: 16, fontWeight: 600 }}>{title}</div>
        <div style={{ padding: '0 20px 18px', fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>{message}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 20px', borderTop: '1px solid var(--color-hover)' }}>
          <button onClick={onCancel} style={{ height: 34, padding: '0 16px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 9, color: 'var(--color-text-secondary)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button onClick={onConfirm} style={{ height: 34, padding: '0 18px', background: danger ? 'var(--color-status-red)' : 'var(--color-accent)', border: 'none', borderRadius: 9, color: danger ? '#fff' : '#08240F', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
