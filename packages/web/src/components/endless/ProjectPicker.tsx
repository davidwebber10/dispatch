import { useState } from 'react';
import { CaretRight, Rows } from '@phosphor-icons/react';
import { useProjects } from '../../stores/projects';

/**
 * The project choice as a section of the composer's + menu (2026-11-05: Chat uses the Control
 * Plane composer, whose only left control is the +). A "Project" row that opens a list in place;
 * picking one (or "No project") sets it and shuts the menu.
 */
export function ProjectMenuSection({ value, onChange, close, mobile = false }: { value: string | null; onChange: (id: string | null) => void; close: () => void; mobile?: boolean }) {
  const sessions = useProjects((s) => s.sessions);
  const [open, setOpen] = useState(false);
  const items = [...sessions].sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  const current = sessions.find((s) => s.id === value)?.name ?? null;
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 12px', background: 'none', border: 'none', color: 'var(--color-text-primary)', font: '500 14px var(--font-sans)', cursor: 'pointer', textAlign: 'left', borderRadius: 'var(--radius-md)' };
  const pick = (id: string | null) => { onChange(id); close(); };
  return (
    <div style={{ borderBottom: '1px solid var(--color-border)', marginBottom: 4, paddingBottom: 4 }}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} style={row}>
        <Rows size={18} />
        <span style={{ flex: 1, minWidth: 0 }}>Project</span>
        <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>{current ?? 'Any'}</span>
        <CaretRight size={13} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s', color: 'var(--color-text-tertiary)' }} />
      </button>
      {open && (
        <div role="menu" aria-label="Projects" style={{ maxHeight: 240, overflowY: 'auto', padding: '2px 0 2px 8px' }}>
          {[{ id: null as string | null, name: 'No project' }, ...items.map((s) => ({ id: s.id as string | null, name: s.name }))].map((it) => (
            <button key={it.id ?? '__none'} type="button" role="menuitemradio" aria-checked={it.id === value} onClick={() => pick(it.id)}
              style={{ ...row, minHeight: mobile ? 44 : undefined, padding: '8px 10px', fontSize: 13.5, fontWeight: 400, color: it.id === null ? 'var(--color-text-secondary)' : 'var(--color-text-primary)' }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</span>
              {it.id === value && <span aria-hidden="true" style={{ color: 'var(--color-accent)' }}>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
