import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * The shared dialog shell.
 *
 * `title` is optional: a panel that IS the control (the New Thread picker) reads better
 * without a heading. `sheet` anchors the panel to the bottom of the viewport as a phone
 * sheet — rounded top corners, a drag handle, safe-area padding — instead of a floating
 * card; callers switch it on with `useIsMobile()`.
 */
export function Modal({ open, onClose, title, sheet = false, anchor = 'center', children }: {
  open: boolean;
  onClose: () => void;
  title?: string;
  sheet?: boolean;
  /**
   * `center` floats the card mid-viewport. `top` pins its top edge a fixed way down,
   * so a panel whose height changes with its own state (the New Thread picker: a
   * shell has no mode/model rows, a harness may have no history) grows and shrinks
   * from the bottom instead of jumping to a new centre on every click.
   */
  anchor?: 'center' | 'top';
  children: ReactNode;
}) {
  if (!open) return null;
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
    // under the keyboard with no overflow left to scroll.
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex',
      alignItems: 'flex-start', justifyContent: 'center', zIndex: 100,
      overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch',
      padding: sheet
        ? 'calc(16px + env(safe-area-inset-top)) 0 0'
        : anchor === 'top'
          ? 'calc(12vh + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left))'
          : 'calc(16px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left))',
    }}>
      {sheet && <style>{'@keyframes dispatch-modal-sheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } }'}</style>}
      <div onClick={(e) => e.stopPropagation()} style={sheet ? {
        width: '100%', marginTop: 'auto', flexShrink: 0, boxSizing: 'border-box',
        background: '#18181B', borderTop: '1px solid #2F2F35', borderRadius: '20px 20px 0 0',
        padding: '8px 16px calc(16px + env(safe-area-inset-bottom))',
        display: 'flex', flexDirection: 'column', gap: 14,
        animation: 'dispatch-modal-sheet-up .18s ease-out',
      } : {
        // `auto` top/bottom margins centre; a zero top margin pins the card under the
        // backdrop's top padding so only its bottom edge moves as content changes.
        width: '100%', maxWidth: 500, margin: anchor === 'top' ? '0 auto auto' : 'auto', flexShrink: 0, boxSizing: 'border-box',
        background: '#18181B', border: '1px solid #2F2F35', borderRadius: 12, padding: 20,
        boxShadow: '0 30px 80px -20px rgba(0,0,0,.85)',
      }}>
        {sheet && <div data-testid="sheet-handle" aria-hidden="true" style={{ width: 36, height: 4, borderRadius: 2, background: '#3A3A40', margin: '0 auto 2px', flex: 'none' }} />}
        {title && <h2 style={{ margin: sheet ? 0 : '0 0 16px', fontSize: 19, fontWeight: 600 }}>{title}</h2>}
        {children}
      </div>
    </div>,
    document.body,
  );
}
