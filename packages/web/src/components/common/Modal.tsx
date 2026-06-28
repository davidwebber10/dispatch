import type { ReactNode } from 'react';

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 500, maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto', boxSizing: 'border-box', background: '#18181B', border: '1px solid #2F2F35', borderRadius: 12, padding: 20, boxShadow: '0 30px 80px -20px rgba(0,0,0,.85)' }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 19, fontWeight: 600 }}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
