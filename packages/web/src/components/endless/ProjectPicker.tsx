import { useEffect, useRef, useState } from 'react';
import { Rows } from '@phosphor-icons/react';
import { useProjects } from '../../stores/projects';

export const iconBtn: React.CSSProperties = { width: 36, height: 36, padding: 0, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-secondary)', cursor: 'pointer' };

/** The composer's project button and its flyout. Opens upward; the parent shows the chosen project as a pill. */
export function ProjectPicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const sessions = useProjects((s) => s.sessions);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = [...sessions].sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  useEffect(() => { if (open) menu.current?.focus(); }, [open]);

  const toggle = () => {
    if (!open) setActive(Math.max(0, items.findIndex((s) => s.id === value)));
    setOpen(!open);
  };
  const choose = (id: string) => { onChange(id); setOpen(false); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter' && items[active]) { e.preventDefault(); choose(items[active].id); }
  };

  return (
    <div ref={root} style={{ position: 'relative', flexShrink: 0 }}>
      <button type="button" aria-label="Choose project" aria-haspopup="menu" aria-expanded={open} onClick={toggle} style={iconBtn}><Rows size={18} /></button>
      {open && (
        <div ref={menu} role="menu" tabIndex={-1} onKeyDown={onKey}
          style={{ position: 'absolute', left: 0, bottom: 'calc(100% + 6px)', zIndex: 20, width: 240, maxWidth: 'calc(100vw - 32px)', maxHeight: 280, overflowY: 'auto', padding: 4, outline: 'none', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 10, boxShadow: '0 10px 30px -10px rgba(0,0,0,.7)' }}>
          {items.length === 0 && <div style={{ padding: '8px 10px', fontSize: 13, color: 'var(--color-text-tertiary)' }}>No projects</div>}
          {items.map((s, k) => (
            <button key={s.id} type="button" role="menuitemradio" aria-checked={s.id === value} tabIndex={-1} onClick={() => choose(s.id)} onMouseEnter={() => setActive(k)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', border: 'none', borderRadius: 7, textAlign: 'left', cursor: 'pointer', fontSize: 13.5, color: 'var(--color-text-primary)', background: k === active ? 'var(--color-hover, rgba(255,255,255,0.08))' : 'transparent' }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
              {s.id === value && <span aria-hidden="true" style={{ color: 'var(--color-accent)' }}>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
