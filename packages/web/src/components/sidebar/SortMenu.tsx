import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * The sort glyph and the font that draws it, shared with the projects sorter in
 * ProjectSidebar so the two controls are literally the same icon.
 *
 * They always agreed on the codepoint; they disagreed on the font, which is what
 * made them look like two different icons. The sidebar's button never set a
 * family, so it kept the UA default (Arial 400) — buttons don't inherit
 * font-family from body. This one spreads the `+` button's style, and that style
 * sets the `font` *shorthand*, which resets family and weight together: IBM Plex
 * Sans at 600, a visibly heavier and differently-shaped U+21C5. Naming one stack
 * in one place is what keeps them from drifting apart again.
 */
export const SORT_GLYPH = '⇅';
export const SORT_GLYPH_FONT = '400 14px/1 Arial, Helvetica, sans-serif';

interface SortMenuProps {
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
  isMobile: boolean;
  /** The host passes the `+` button's style so the two controls match at both sizes. */
  buttonStyle: React.CSSProperties;
}

/**
 * Sort picker for the project card's list tabs. The panel is portalled to
 * document.body on purpose: the card's collapse animation uses
 * `grid-template-rows: 0fr` with `overflow: hidden`, which would clip a panel
 * positioned inside the card.
 */
export function SortMenu({ value, options, onChange, isMobile, buttonStyle }: SortMenuProps) {
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
      {/* `font` comes after the spread on purpose: buttonStyle is the `+` button's
          style, whose own `font` shorthand would otherwise pick the family, weight
          and size for us. The box still comes from buttonStyle, so the control stays
          the same size and touch target as the `+` it sits beside. */}
      <button ref={btnRef} title="Sort" aria-label="Sort" onClick={toggle}
        style={{ ...buttonStyle, alignSelf: 'center', font: SORT_GLYPH_FONT }}>{SORT_GLYPH}</button>
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
