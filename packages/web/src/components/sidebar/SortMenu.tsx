import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * The sort glyph, and the font ProjectSidebar's (desktop-only) projects sorter draws it in.
 *
 * The glyph is Arial's U+21C5 — IBM Plex's is heavier and oddly-proportioned. SortMenu (used
 * on the project card, including the mobile header) does NOT use SORT_GLYPH_FONT: it derives a
 * responsive font (see `glyphFont` below) that matches the neighbouring `+` button's WEIGHT
 * and SIZE at each breakpoint, since a fixed 400/14px looked both thinner and (on mobile,
 * beside a 26px `+`) much smaller than the `+`.
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

  // Match the neighbouring `+` button's weight AND size so the two read as one icon set, but
  // keep Arial's cleaner U+21C5 shape. The `+` is `600 14px` on desktop and `500 26px` on
  // mobile (ProjectCard's plusBtn/plusStyle); the ⇅'s arrows run the full em-height, so mobile
  // sits a touch under 26px to line up visually rather than overshoot the box.
  const glyphFont = isMobile ? '500 22px/1 Arial, Helvetica, sans-serif' : '600 14px/1 Arial, Helvetica, sans-serif';

  return (
    <>
      {/* `font` comes after the spread on purpose: buttonStyle is the `+` button's style, whose
          own `font` shorthand would otherwise pick the family/weight/size. The box still comes
          from buttonStyle, so the control keeps the same size + touch target as the `+`. */}
      <button ref={btnRef} title="Sort" aria-label="Sort" onClick={toggle}
        style={{ ...buttonStyle, alignSelf: 'center', font: glyphFont }}>{SORT_GLYPH}</button>
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
