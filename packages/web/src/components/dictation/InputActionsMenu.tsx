import { useEffect, useRef, useState } from 'react';
import { Plus, Paperclip, Microphone } from '@phosphor-icons/react';

interface Props {
  onAddFile: () => void;
  /** Omitted when the host shows its own mic (the shared PillComposer): no Dictate row. */
  onDictate?: () => void;
  dictateDisabled?: boolean;
  dictateHint?: string;
  /** Host-supplied override so the trigger can mirror the adjacent send button's footprint. */
  triggerStyle?: React.CSSProperties;
  /** Extra rows above Add file (Chat's project choice). Gets `close` to shut the flyout. */
  extra?: (close: () => void) => React.ReactNode;
}

const trigger = {
  flexShrink: 0, width: 40, height: 40, borderRadius: 'var(--radius-lg)', display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'var(--color-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', cursor: 'pointer',
} as const;

const rowBtn = (disabled?: boolean) => ({
  display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 12px', background: 'none', border: 'none',
  color: disabled ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)', font: '500 14px var(--font-sans)',
  cursor: disabled ? 'default' : 'pointer', textAlign: 'left' as const, borderRadius: 'var(--radius-md)',
});

export { rowBtn as inputMenuRow };

export function InputActionsMenu({ onAddFile, onDictate, dictateDisabled, dictateHint, triggerStyle, extra }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button type="button" aria-label="More input options" onClick={() => setOpen((o) => !o)} style={{ ...trigger, ...triggerStyle }}>
        <Plus size={20} weight="bold" />
      </button>
      {open && (
        <div style={{
          position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, minWidth: 200, padding: 6,
          background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)',
          boxShadow: '0 12px 34px -10px rgba(0,0,0,.7)', zIndex: 40,
        }}>
          {extra?.(() => setOpen(false))}
          <button type="button" style={rowBtn()} onClick={() => { setOpen(false); onAddFile(); }}>
            <Paperclip size={18} /> Add file
          </button>
          {onDictate && (
            <button type="button" style={rowBtn(dictateDisabled)} disabled={dictateDisabled} onClick={() => { setOpen(false); onDictate(); }}>
              <Microphone size={18} /> Dictate
            </button>
          )}
          {onDictate && dictateDisabled && dictateHint && (
            <div style={{ padding: '2px 12px 8px', fontSize: 11, color: 'var(--color-text-tertiary)' }}>{dictateHint}</div>
          )}
        </div>
      )}
    </div>
  );
}
