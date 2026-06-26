import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';

const TYPES: { type: string; label: string; config?: Record<string, unknown> }[] = [
  { type: 'claude-code', label: 'Claude Code' },
  { type: 'codex', label: 'Codex' },
  { type: 'shell', label: 'Terminal' },
];

export function NewTabMenu({ sessionId, onClose, onCreated, onPickClaude }: { sessionId: string; onClose: () => void; onCreated?: (terminalId: string) => void; onPickClaude?: () => void }) {
  // Anchor fills the trigger button; the menu itself is portaled to <body> with
  // fixed positioning so the card's overflow:hidden (used for the expand animation)
  // can't clip it.
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const MENU_W = 184;

  useLayoutEffect(() => {
    const r = anchorRef.current?.getBoundingClientRect();
    // Open left-aligned to the button's right edge so the menu stays within the
    // sidebar instead of spilling across the sidebar/main boundary.
    if (r) setPos({ top: r.bottom + 6, left: Math.max(8, r.right - MENU_W) });
  }, []);

  async function add(t: (typeof TYPES)[number]) {
    onClose();
    // Claude Code opens the name/resume modal instead of creating instantly.
    if (t.type === 'claude-code' && onPickClaude) { onPickClaude(); return; }
    try {
      const term = await api.createTerminal(sessionId, { type: t.type, ...(t.config ? { config: t.config } : {}) });
      await useTabs.getState().loadTabs(sessionId);
      useTabs.getState().markLoading(term.id);
      onCreated?.(term.id);
    } catch { /* surfaced via connection state */ }
  }

  return (
    <span ref={anchorRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {createPortal(
        <>
          <div onClick={(e) => { e.stopPropagation(); onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 200 }} />
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden', zIndex: 201, width: MENU_W, background: '#1B1B1E', border: '1px solid #2C2C32', borderRadius: 9, padding: 4, boxShadow: '0 20px 50px -20px rgba(0,0,0,.8)' }}>
            <div style={{ font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)', padding: '4px 8px' }}>NEW THREAD</div>
            {TYPES.map((t) => (
              <button key={t.type} onClick={() => void add(t)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px', background: 'transparent', border: 'none', borderRadius: 6, color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }}>{t.label}</button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </span>
  );
}
