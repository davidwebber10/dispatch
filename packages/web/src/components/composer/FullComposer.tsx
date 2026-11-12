import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, ArrowsInSimple } from '@phosphor-icons/react';
import { fontVarInput } from '../../lib/fontSize';

/**
 * The phone's full-screen message editor (owner, 2026-11-07: "for longer prompts"). The composer's
 * expand button opens it with the same text. It does not focus the text: a long prompt can be read
 * and scrolled first, and a tap in it brings up the keyboard. While the keyboard is up the panel
 * fits the visible part of the screen, so Send stays above it. Phone only: the desktop's box is
 * already wide.
 */
export function FullComposer({ value, onChange, onSend, canSend, onClose, placeholder, sendLabel = 'Send', textareaProps }: {
  value: string; onChange: (v: string) => void; onSend: () => void; canSend: boolean; onClose: () => void;
  placeholder?: string; sendLabel?: string; textareaProps?: React.TextareaHTMLAttributes<HTMLTextAreaElement>;
}) {
  const [viewH, setViewH] = useState<number | null>(null);
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const onResize = () => setViewH(Math.round(vv.height + vv.offsetTop));
    onResize();
    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', onResize);
    return () => { vv.removeEventListener('resize', onResize); vv.removeEventListener('scroll', onResize); };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const round = { width: 44, height: 44, padding: 0, borderRadius: '50%', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' } as const;
  return createPortal(
    <div style={{ position: 'fixed', left: 0, right: 0, top: 0, height: viewH ?? '100%', zIndex: 120, background: 'var(--color-overlay)' }}>
      <div role="dialog" aria-modal="true" aria-label="Message" style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, top: 'calc(env(safe-area-inset-top) + 8px)',
        background: 'var(--color-elevated)', borderRadius: 'var(--radius-2xl) var(--radius-2xl) 0 0', borderTop: '1px solid var(--color-border)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <button type="button" aria-label="Collapse the message" title="Collapse" onClick={onClose}
          style={{ ...round, position: 'absolute', top: 10, right: 10, zIndex: 1, background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
          <ArrowsInSimple size={22} />
        </button>
        <textarea
          {...textareaProps}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          enterKeyHint="enter"
          style={{
            flex: 1, minHeight: 0, width: '100%', boxSizing: 'border-box', margin: 0, resize: 'none', overflowY: 'auto',
            border: 'none', outline: 'none', background: 'transparent', color: 'var(--color-text-primary)',
            font: `400 ${fontVarInput(17)} var(--font-sans)`, lineHeight: 1.55, padding: '22px 56px 88px 20px',
          }}
        />
        <button type="button" aria-label={sendLabel} title={sendLabel} disabled={!canSend}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onSend(); onClose(); }}
          style={{ ...round, position: 'absolute', right: 16, bottom: 'calc(16px + env(safe-area-inset-bottom))',
            background: canSend ? 'var(--color-accent)' : 'var(--color-hover)', color: canSend ? 'var(--color-on-accent)' : 'var(--color-text-tertiary)', cursor: canSend ? 'pointer' : 'default' }}>
          <ArrowUp size={20} weight="bold" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
