import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowsDownUp } from '@phosphor-icons/react';

interface SortMenuProps {
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
  isMobile: boolean;
  /** The host passes the `+` button's style so the two controls share a box + touch target. */
  buttonStyle: React.CSSProperties;
  /** Icon px size — pass the SAME size as the host's neighbouring `+` (Plus) icon so the sort
   *  and add controls are stylistically identical. Defaults per breakpoint. */
  iconSize?: number;
}

/**
 * Sort picker for the project card's list tabs. The panel is portalled to
 * document.body on purpose: the card's collapse animation uses
 * `grid-template-rows: 0fr` with `overflow: hidden`, which would clip a panel
 * positioned inside the card.
 */
export function SortMenu({ value, options, onChange, isMobile, buttonStyle, iconSize }: SortMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      // Clamp so a right-aligned panel can't run off a narrow mobile viewport.
      const right = Math.max(8, window.innerWidth - r.right);
      setPos({ top: r.bottom + 6, right });
    }
    setOpen((o) => !o);
  }

  return (
    <>
      {/* Phosphor ArrowsDownUp — the SAME icon family as the neighbouring `+` (Plus), so the sort
          and add controls are stylistically identical. Size matches the host's `+` icon; the box
          and colour still come from buttonStyle (the `+` button's style). */}
      <button ref={btnRef} title="Sort" aria-label="Sort" onClick={toggle}
        style={{ ...buttonStyle, alignSelf: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <ArrowsDownUp size={iconSize ?? (isMobile ? 18 : 14)} weight="bold" />
      </button>
      {open && createPortal(
        <>
          <div data-testid="sort-menu-backdrop" onClick={(e) => { e.stopPropagation(); setOpen(false); }} style={{ position: 'fixed', inset: 0, zIndex: 300 }} />
          <div data-testid="sort-menu-panel" style={{ position: 'fixed', top: pos.top, right: pos.right, zIndex: 301, minWidth: isMobile ? 200 : 168, background: '#1B1B1E', border: '1px solid #2C2C32', borderRadius: 9, padding: 4, boxShadow: '0 20px 50px -20px rgba(0,0,0,.8)' }}>
            <div style={{ font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)', padding: '4px 8px' }}>SORT BY</div>
            {options.map(([v, label]) => (
              <button key={v} onClick={(e) => { e.stopPropagation(); onChange(v); setOpen(false); }}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: isMobile ? '10px 8px' : '6px 8px', background: value === v ? 'var(--color-hover)' : 'transparent', border: 'none', borderRadius: 6, color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: isMobile ? 15 : 13 }}>
                {label}{value === v ? '  ·' : ''}
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </>
  );
}
