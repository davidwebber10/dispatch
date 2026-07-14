import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NewThreadKind } from './NewThreadModal';

const KINDS: { kind: NewThreadKind; label: string }[] = [
  { kind: 'claude-code', label: 'Claude Code' },
  { kind: 'claude-structured', label: 'Claude (structured)' },
  { kind: 'codex', label: 'Codex' },
  { kind: 'shell', label: 'Terminal' },
];

/**
 * The "+" menu. Every type now opens the unified New Thread modal (with that type
 * preselected) rather than some creating instantly — that's what gives every type
 * a place to set auto-archive at creation.
 */
export function NewTabMenu({ onClose, onPick }: { onClose: () => void; onPick: (kind: NewThreadKind) => void }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const MENU_W = 184;

  useLayoutEffect(() => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, left: Math.max(8, r.right - MENU_W) });
  }, []);

  return (
    <span ref={anchorRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {createPortal(
        <>
          <div onClick={(e) => { e.stopPropagation(); onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 200 }} />
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden', zIndex: 201, width: MENU_W, background: '#1B1B1E', border: '1px solid #2C2C32', borderRadius: 9, padding: 4, boxShadow: '0 20px 50px -20px rgba(0,0,0,.8)' }}>
            <div style={{ font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)', padding: '4px 8px' }}>NEW THREAD</div>
            {KINDS.map((k) => (
              <button key={k.kind} onClick={() => { onClose(); onPick(k.kind); }}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px', background: 'transparent', border: 'none', borderRadius: 6, color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }}>
                {k.label}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </span>
  );
}
