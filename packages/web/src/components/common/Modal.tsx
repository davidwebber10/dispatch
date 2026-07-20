import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  // Portal to <body>: on mobile this modal's parents (the slide-rail) use a CSS
  // transform, which re-bases position:fixed to the transformed ancestor instead
  // of the viewport — trapping the modal off-screen. Portaling escapes that.
  return createPortal(
    // The BACKDROP scrolls, not the panel, and the panel centres via `margin:auto`.
    // Auto margins on a flex child centre it when there is spare room and top-align
    // it (without clipping, unlike align-items:center) when there is not — so a tall
    // modal opens at the top and scrolls, a short one stays centred.
    //
    // The panel deliberately has NO maxHeight: `100dvh` does not shrink for the
    // on-screen keyboard, so clamping to it left the bottom of a tall modal stranded
    // under the keyboard with no overflow left to scroll.
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 100, overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', padding: 'calc(16px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left))' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 500, margin: 'auto', flexShrink: 0, boxSizing: 'border-box', background: '#18181B', border: '1px solid #2F2F35', borderRadius: 12, padding: 20, boxShadow: '0 30px 80px -20px rgba(0,0,0,.85)' }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 19, fontWeight: 600 }}>{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
