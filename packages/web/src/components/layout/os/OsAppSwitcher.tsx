import { useEffect, useRef, useState } from 'react';
import { CaretDown } from '@phosphor-icons/react';
import { PRODUCT_NAME } from '../../../lib/hostCopy';
import { loadOsShell, type OsShell } from './shellApi';
import { osIcon, PRODUCT_ICON } from './OsIcon';
import './os-shell.css';

/** The OS app list, once per page (null while loading or when OS did not answer). */
export function useOsShell(): OsShell | null {
  const [shell, setShell] = useState<OsShell | null>(null);
  useEffect(() => { let on = true; void loadOsShell().then((s) => { if (on) setShell(s); }); return () => { on = false; }; }, []);
  return shell;
}

/**
 * The app switcher at the top-left, as OS's SubAppSwitcher: the trigger names the current app (its icon
 * and PRODUCT_NAME, 20px semibold) with a caret; open, a card slides down under it with the OS apps the
 * person can open. Choosing another app is a full-page navigation to its URL. With no answer from OS,
 * the card lists only the current app.
 */
export function OsSwitcherTrigger({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const Icon = PRODUCT_ICON;
  return (
    <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className={open ? undefined : 'os-hover'}
      style={{
        display: 'flex', width: '100%', minWidth: 0, alignItems: 'center', gap: 12, padding: '10px 8px', border: 'none', textAlign: 'left', cursor: 'pointer',
        color: 'var(--color-text-primary)', borderRadius: open ? 'var(--radius-md) var(--radius-md) 0 0' : 'var(--radius-md)',
        background: open ? 'color-mix(in srgb, var(--color-hover) 50%, transparent)' : 'transparent', transition: 'background-color .15s',
      }}>
      <Icon size={18} style={{ flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '600 20px/28px var(--font-sans)', letterSpacing: '-0.025em' }}>{PRODUCT_NAME}</span>
      <CaretDown size={20} style={{ marginLeft: 'auto', flexShrink: 0, color: 'var(--color-text-secondary)', transition: 'transform .2s', transform: open ? 'rotate(180deg)' : 'none' }} />
    </button>
  );
}

export function OsSwitcherPanel({ open, onClose, shell }: { open: boolean; onClose: () => void; shell: OsShell | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || ref.current?.contains(t) || t.closest('[aria-haspopup="menu"]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open, onClose]);

  // The current app is Dispatch: the entry OS marks `current`, else one made here.
  const apps = shell?.apps.length ? shell.apps : [];
  const hasCurrent = apps.some((a) => a.current);
  const rows = hasCurrent ? apps : [{ id: 'dispatch', label: PRODUCT_NAME, icon: '', url: '', current: true }, ...apps];

  return (
    <div ref={ref} role="menu" aria-hidden={!open} className="os-switch-panel" style={{ gridTemplateRows: open ? '1fr' : '0fr' }}>
      <div style={{ overflow: 'hidden' }}>
        <div style={{ padding: '0 8px 8px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: 4, borderRadius: '0 0 var(--radius-md) var(--radius-md)', background: 'color-mix(in srgb, var(--color-hover) 50%, transparent)' }}>
            {rows.map((a) => {
              const Icon = a.current ? PRODUCT_ICON : osIcon(a.icon);
              return (
                <a key={a.id} role="menuitem" tabIndex={open ? 0 : -1} aria-current={a.current ? 'true' : undefined}
                  href={a.current ? undefined : a.url} className="os-switch-item"
                  onClick={(e) => { if (a.current) { e.preventDefault(); onClose(); } }}>
                  <Icon size={18} style={{ flexShrink: 0 }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.current ? PRODUCT_NAME : a.label}</span>
                </a>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The trigger and its card as one outlined block (OS: the border shows only while open). */
export function OsAppSwitcher({ shell, open, setOpen }: { shell: OsShell | null; open: boolean; setOpen: (v: boolean) => void }) {
  return (
    <div style={{ position: 'relative', zIndex: 40, flexShrink: 0, borderRadius: 'var(--radius-lg)', border: `1px solid ${open ? 'var(--color-border)' : 'transparent'}`, background: 'var(--color-pane)', transition: 'border-color .15s' }}>
      <div style={{ padding: open ? '8px 8px 0' : 8, transition: 'padding .2s ease-out' }}>
        <OsSwitcherTrigger open={open} onToggle={() => setOpen(!open)} />
      </div>
      <OsSwitcherPanel open={open} onClose={() => setOpen(false)} shell={shell} />
    </div>
  );
}

/** OS dims the page while the switcher is open (black/40 + a small blur). */
export function OsSpotlight({ open }: { open: boolean }) {
  return (
    <div aria-hidden style={{
      position: 'fixed', inset: 0, zIndex: 30, background: 'var(--color-overlay)', backdropFilter: 'blur(4px)',
      opacity: open ? 1 : 0, pointerEvents: 'none', transition: 'opacity .2s ease-out',
    }} />
  );
}
