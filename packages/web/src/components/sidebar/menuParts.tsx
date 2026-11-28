// The pieces of the thread options menu (the grid of tiles, the rows, the two shells), shared with
// Chat's menu (owner, 2026-11-27: the same layout, with Chat's own options).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Icon } from '@phosphor-icons/react';
import { fontVar } from '../../lib/fontSize';

/** One body, two shells (2026-11-07): the phone's slide-up sheet and the desktop's fly-out show the
 *  same groups; only the sizes differ. `sheet` is finger-sized, `popover` is mouse-sized. */
export type Density = 'sheet' | 'popover';
const baseRow: React.CSSProperties = { display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', color: 'var(--color-text-primary)', cursor: 'pointer' };
export const SIZES: Record<Density, { row: React.CSSProperties; icon: number; tileIcon: number; tile: React.CSSProperties; caption: React.CSSProperties; hint: number; gap: number; pad: string }> = {
  sheet: {
    row: { ...baseRow, gap: 12, padding: '11px 12px', fontSize: fontVar(15), borderRadius: 'var(--radius-md)' },
    icon: 20, tileIcon: 22, hint: 12.5, gap: 8, pad: '2px 4px 6px',
    tile: { height: 72, fontSize: fontVar(12), borderRadius: 'var(--radius-lg)' },
    caption: { padding: '10px 12px 2px', fontSize: fontVar(11.5) },
  },
  popover: {
    row: { ...baseRow, gap: 10, padding: '7px 10px', fontSize: fontVar(13), borderRadius: 'var(--radius-sm)' },
    icon: 16, tileIcon: 18, hint: 11.5, gap: 6, pad: '2px 2px 4px',
    tile: { height: 58, fontSize: fontVar(11.5), borderRadius: 'var(--radius-md)' },
    caption: { padding: '8px 10px 2px', fontSize: fontVar(10.5) },
  },
};
/** A quick-action tile at the top of the menu: icon above a short label. */
const tileBase: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, minWidth: 0, padding: '0 4px',
  background: 'var(--color-elevated)', border: '1px solid var(--color-border)',
  color: 'var(--color-text-primary)', fontWeight: 500, cursor: 'pointer',
};
/** A group's small caption ("View", "Plugins"). */
export const captionBase: React.CSSProperties = { fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--color-text-tertiary)' };
export const rule = <div aria-hidden style={{ height: 1, background: 'var(--color-border)', margin: '6px 6px' }} />;
/** The desktop fly-out's width and its distance from the viewport's edges. */
const FLYOUT_W = 320;
const EDGE = 8;

/** Arrow keys walk the menu's buttons (tiles included) and wrap; Home and End jump. Enter is the
 *  button's own. */
export function moveFocus(e: React.KeyboardEvent<HTMLElement>) {
  const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
  if (!step && e.key !== 'Home' && e.key !== 'End') return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])'));
  if (items.length === 0) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
    : at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
  items[next].focus();
}

export type MenuTile = { key: string; Glyph: Icon; label: string; name: string; onClick: () => void; pressed?: boolean; disabled?: boolean; /** The current setting, as a small second line. */ value?: string | null };

/** The quick actions at the top of a menu: four to a row, or `columns`. */
export function MenuTiles({ z, tiles, columns = 4 }: { z: (typeof SIZES)[Density]; tiles: MenuTile[]; columns?: number }) {
  return (
    <div role="group" aria-label="Quick actions" style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: z.gap, padding: z.pad }}>
      {tiles.map((x) => (
        <button key={x.key} type="button" aria-label={x.name} aria-pressed={x.pressed} disabled={x.disabled} onClick={x.onClick}
          style={{ ...tileBase, ...z.tile, ...(x.value ? { gap: 4 } : {}), ...(x.pressed ? { color: 'var(--color-accent)', borderColor: 'var(--color-accent)' } : {}) }}>
          <x.Glyph size={z.tileIcon} weight={x.pressed ? 'fill' : 'regular'} />
          <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.label}</span>
          {x.value && <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 400, fontSize: fontVar(11), color: 'var(--color-text-tertiary)' }}>{x.value}</span>}
        </button>
      ))}
    </div>
  );
}

/** A menu row: icon, label, and an optional plain-words line under it. */
export function MenuRow({ z, id, Glyph, label, onClick, hint, extra = {}, trailing, disabled }: {
  z: (typeof SIZES)[Density]; id: string; Glyph: Icon; label: string; onClick: () => void; hint?: string; extra?: React.CSSProperties; trailing?: React.ReactNode; disabled?: boolean;
}) {
  const hintId = hint ? id : undefined;
  return (
    <button type="button" disabled={disabled} onClick={onClick} aria-label={hint ? label : undefined} aria-describedby={hintId}
      style={{ ...z.row, alignItems: hint ? 'flex-start' : 'center', ...(disabled ? { opacity: 0.5, cursor: 'default' } : {}), ...extra }}>
      <Glyph size={z.icon} style={{ flexShrink: 0, marginTop: hint ? 1 : 0 }} />
      {hint ? (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span>{label}</span>
          <span id={hintId} style={{ fontSize: fontVar(z.hint), color: 'var(--color-text-tertiary)' }}>{hint}</span>
        </span>
      ) : label}
      {trailing}
    </button>
  );
}

/** The desktop shell: a fly-out at the click, kept inside the viewport (it slides up, or in,
 *  when there is no room below or to the right), with its own scroll. Escape or a click outside
 *  closes it. */
export function FlyOut({ x, y, onClose, label, children }: { x: number; y: number; onClose: () => void; label: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const left = Math.max(EDGE, Math.min(x, window.innerWidth - EDGE - FLYOUT_W));
  const [top, setTop] = useState(y);
  // Measured after every render, not only on open: a row can appear later (a plugin loads), and the
  // fly-out must not grow off the bottom. setTop with an unchanged value is a no-op, so this settles.
  useLayoutEffect(() => {
    const h = ref.current?.getBoundingClientRect().height ?? 0;
    const room = window.innerHeight - EDGE;
    // Slide up only as far as needed, so the menu stays as close to the pointer as it can.
    setTop(Math.max(EDGE, Math.min(y, room - h)));
  });
  // Callers pass a fresh onClose each render; read it through a ref so a parent's re-render does
  // not pull the focus back to the first item.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close.current(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return createPortal(
    <>
      <div data-testid="thread-menu-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 300 }} />
      <div ref={ref} role="menu" aria-label={label} onKeyDown={moveFocus}
        style={{
          position: 'fixed', top, left, zIndex: 301, width: FLYOUT_W, maxHeight: `calc(100vh - ${EDGE * 2}px)`, overflowY: 'auto',
          display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
          background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-lg)',
          padding: 6, boxShadow: '0 20px 50px -20px var(--color-shadow-strong)',
        }}>
        {children}
      </div>
    </>,
    document.body,
  );
}
