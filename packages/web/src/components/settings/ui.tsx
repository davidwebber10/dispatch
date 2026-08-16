/**
 * Shared presentational primitives for the settings sections.
 *
 * These used to live as module-private constants inside SettingsModal. They moved
 * here when the sections were split into standalone components so that both the
 * desktop modal and the mobile full-screen settings screens render identically.
 */

import { useState } from 'react';

export const sectionLabel: React.CSSProperties = { font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)' };
export const pageLabel: React.CSSProperties = { font: '700 11px var(--font-mono)', letterSpacing: '1.3px', color: 'var(--color-text-secondary)' };
export const summaryLine: React.CSSProperties = { font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' };
export const ghostBtn: React.CSSProperties = { height: 30, padding: '0 12px', background: 'transparent', border: '1px solid #2c2c32', borderRadius: 7, color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' };
export const miniChip: React.CSSProperties = { flexShrink: 0, font: '500 9.5px var(--font-mono)', letterSpacing: '0.6px', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', border: '1px solid #2c2c32', borderRadius: 4, padding: '1px 5px' };
export const codeChip: React.CSSProperties = { font: '400 11px var(--font-mono)', color: '#c9c9cf', background: 'var(--color-elevated)', border: '1px solid #2c2c32', borderRadius: 5, padding: '1px 5px', whiteSpace: 'nowrap' };
export const fieldInput: React.CSSProperties = { minWidth: 0, height: 30, padding: '0 9px', background: '#1b1b1e', border: '1px solid #2c2c32', borderRadius: 7, color: 'var(--color-text-primary)', font: '400 12px var(--font-sans)' };
export const solidBtn = (on: boolean): React.CSSProperties => ({ flexShrink: 0, height: 30, padding: '0 14px', background: 'var(--color-accent)', border: 'none', borderRadius: 7, color: '#08240F', fontWeight: 600, fontSize: 12.5, cursor: on ? 'pointer' : 'default', opacity: on ? 1 : 0.5 });
export const row: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 };
export const item: React.CSSProperties = { fontSize: 13, color: '#c9c9cf' };
export const chip: React.CSSProperties = { font: '400 11.5px var(--font-mono)', color: '#c9c9cf', background: '#1b1b1e', border: '1px solid #2c2c32', borderRadius: 7, padding: '5px 10px' };
export const iconBtn: React.CSSProperties = { width: 26, height: 26, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: '1px solid #2c2c32', borderRadius: 6, color: 'var(--color-text-secondary)', cursor: 'pointer' };

export function Divider() { return <div style={{ height: 1, background: 'var(--color-hover)' }} />; }

export function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ width: 38, height: 21, borderRadius: 11, border: 'none', cursor: 'pointer', background: on ? 'var(--color-accent)' : '#34343a', position: 'relative', transition: 'background .15s ease', flexShrink: 0 }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 19 : 2, width: 17, height: 17, borderRadius: '50%', background: on ? '#08240F' : '#e9e9ec', transition: 'left .15s ease' }} />
    </button>
  );
}

export function GroupHeader({ label, count, tone = 'neutral', hint }: { label: string; count?: number; tone?: 'accent' | 'red' | 'neutral'; hint?: string }) {
  const color = tone === 'accent' ? 'var(--color-accent)' : tone === 'red' ? 'var(--color-status-red)' : 'var(--color-text-tertiary)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
      <span style={{ font: '600 9.5px var(--font-mono)', letterSpacing: '1.2px', textTransform: 'uppercase', color, flexShrink: 0 }}>{label}</span>
      {count !== undefined && <span style={{ font: '400 9.5px var(--font-mono)', color: 'var(--color-text-tertiary)', flexShrink: 0 }}>{count}</span>}
      <span style={{ flex: 1, height: 1, background: 'var(--color-hover)' }} />
      {hint && <span style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>{hint}</span>}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder, style }: { value: string; onChange: (v: string) => void; placeholder: string; style?: React.CSSProperties }) {
  return (
    <span style={{ position: 'relative', display: 'flex', flex: 1, minWidth: 0, ...style }}>
      <span aria-hidden style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)', pointerEvents: 'none' }}>/</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={{ ...fieldInput, flex: 1, paddingLeft: 24 }} />
    </span>
  );
}

export function FilterSegments({ options, active, onSelect }: { options: { key: string; label: string; count?: number }[]; active: string; onSelect: (key: string) => void }) {
  return (
    <span style={{ display: 'flex', border: '1px solid #2c2c32', borderRadius: 7, overflow: 'hidden', flexShrink: 0 }}>
      {options.map((o, idx) => {
        const on = o.key === active;
        return (
          <button key={o.key} onClick={() => onSelect(o.key)}
            style={{ height: 28, padding: '0 10px', background: on ? 'var(--color-hover)' : 'transparent', border: 'none', borderLeft: idx > 0 ? '1px solid #2c2c32' : 'none', color: on ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)', font: '500 11px var(--font-mono)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            {o.label}{o.count !== undefined ? ` ${o.count}` : ''}
          </button>
        );
      })}
    </span>
  );
}

export function HoverRow({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  const [hover, setHover] = useState(false);
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ borderTop: '1px solid var(--color-hover)', background: hover ? 'color-mix(in srgb, var(--color-hover) 45%, transparent)' : 'transparent', ...style }}>
      {children}
    </div>
  );
}

export function IconGhost({ title, onClick, active, danger, children }: { title: string; onClick: () => void; active?: boolean; danger?: boolean; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  const color = active ? 'var(--color-accent)' : danger && hover ? 'var(--color-status-red)' : 'var(--color-text-secondary)';
  return (
    <button title={title} onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ width: 24, height: 24, padding: 0, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', borderRadius: 5, color, cursor: 'pointer' }}>
      {children}
    </button>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,0.55)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <style>{'@keyframes dispatch-sheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } }'}</style>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--color-elevated)', borderRadius: '14px 14px 0 0', padding: '16px 16px calc(16px + env(safe-area-inset-bottom))', display: 'flex', flexDirection: 'column', gap: 10, maxHeight: '85dvh', overflowY: 'auto', animation: 'dispatch-sheet-up .18s ease-out' }}>
        {title && <span style={{ ...pageLabel, marginBottom: 2 }}>{title}</span>}
        {children}
      </div>
    </div>
  );
}

export function Stepper({ value, unit, onDec, onInc }: { value: string; unit?: string; onDec: () => void; onInc: () => void }) {
  const btn = (side: 'l' | 'r'): React.CSSProperties => ({ width: 28, height: 28, background: '#1b1b1e', border: '1px solid #2c2c32', borderRadius: side === 'l' ? '7px 0 0 7px' : '0 7px 7px 0', color: 'var(--color-text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '500 14px var(--font-sans)' });
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <button onClick={onDec} style={btn('l')}>−</button>
      <div style={{ height: 28, minWidth: 64, background: '#1b1b1e', borderTop: '1px solid #2c2c32', borderBottom: '1px solid #2c2c32', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 10px', font: '400 11.5px var(--font-mono)', color: '#c9c9cf' }}>{value}{unit ?? ''}</div>
      <button onClick={onInc} style={btn('r')}>+</button>
    </div>
  );
}
