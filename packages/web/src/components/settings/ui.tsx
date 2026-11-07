/**
 * Shared presentational primitives for the settings sections, so the desktop page
 * (SettingsView) and the phone's drill-down (MobileSettings) render every section
 * identically. `sectionLabel` is the one heading style; `Toggle` is the one switch.
 */

import { Modal } from '../common/Modal';
import { useState } from 'react';

export const sectionLabel: React.CSSProperties = { font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)' };
export const summaryLine: React.CSSProperties = { font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' };
export const ghostBtn: React.CSSProperties = { height: 30, padding: '0 12px', background: 'transparent', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' };
export const miniChip: React.CSSProperties = { flexShrink: 0, font: '500 9.5px var(--font-mono)', letterSpacing: '0.6px', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-xs)', padding: '1px 5px' };
export const codeChip: React.CSSProperties = { font: '400 11px var(--font-mono)', color: 'var(--color-text-body)', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)', padding: '1px 5px', whiteSpace: 'nowrap' };
export const fieldInput: React.CSSProperties = { minWidth: 0, height: 30, padding: '0 9px', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-primary)', font: '400 12px var(--font-sans)' };
export const solidBtn = (on: boolean): React.CSSProperties => ({ flexShrink: 0, height: 30, padding: '0 14px', background: 'var(--color-accent)', border: 'none', borderRadius: 'var(--radius-sm)', color: 'var(--color-on-accent)', fontWeight: 600, fontSize: 12.5, cursor: on ? 'pointer' : 'default', opacity: on ? 1 : 0.5 });
export const row: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 };
export const item: React.CSSProperties = { fontSize: 13, color: 'var(--color-text-body)' };
export const chip: React.CSSProperties = { font: '400 11.5px var(--font-mono)', color: 'var(--color-text-body)', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)', padding: '5px 10px' };
export const iconBtn: React.CSSProperties = { width: 26, height: 26, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-secondary)', cursor: 'pointer' };

/** This browser's link to the daemon, worded the same in the desktop nav and in Settings → Servers. */
export const CONNECTION_STATUS = {
  open:       { color: 'var(--color-accent)', label: 'Connected' },
  connecting: { color: 'var(--color-status-yellow)', label: 'Reconnecting…' },
  closed:     { color: 'var(--color-status-red)', label: 'Disconnected' },
} as const;

export function Divider() { return <div style={{ height: 1, background: 'var(--color-hover)' }} />; }

export function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label?: string }) {
  return (
    <button type="button" onClick={onClick} {...(label ? { role: 'switch', 'aria-checked': on, 'aria-label': label } : {})} style={{ width: 38, height: 21, borderRadius: 'var(--radius-lg)', border: 'none', cursor: 'pointer', background: on ? 'var(--color-accent)' : 'var(--color-border-hover)', position: 'relative', transition: 'background .15s ease', flexShrink: 0 }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 19 : 2, width: 17, height: 17, borderRadius: '50%', background: on ? 'var(--color-on-accent)' : 'var(--color-text-primary)', transition: 'left .15s ease' }} />
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
    <span style={{ display: 'flex', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)', overflow: 'hidden', flexShrink: 0 }}>
      {options.map((o, idx) => {
        const on = o.key === active;
        return (
          <button key={o.key} onClick={() => onSelect(o.key)}
            style={{ height: 28, padding: '0 10px', background: on ? 'var(--color-hover)' : 'transparent', border: 'none', borderLeft: idx > 0 ? '1px solid var(--color-border-strong)' : 'none', color: on ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)', font: '500 11px var(--font-mono)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
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
      style={{ width: 24, height: 24, padding: 0, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', borderRadius: 'var(--radius-sm)', color, cursor: 'pointer' }}>
      {children}
    </button>
  );
}

/** The settings' add-item sheet: the app's one shared slide-up sheet (common/Modal), sentence-case title. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  return (
    <Modal open={open} sheet title={title} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{children}</div>
    </Modal>
  );
}

export function Stepper({ value, unit, onDec, onInc }: { value: string; unit?: string; onDec: () => void; onInc: () => void }) {
  const btn = (side: 'l' | 'r'): React.CSSProperties => ({ width: 28, height: 28, background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: side === 'l' ? 'var(--radius-sm) 0 0 var(--radius-sm)' : '0 var(--radius-sm) var(--radius-sm) 0', color: 'var(--color-text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '500 14px var(--font-sans)' });
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <button onClick={onDec} style={btn('l')}>−</button>
      <div style={{ height: 28, minWidth: 64, background: 'var(--color-elevated)', borderTop: '1px solid var(--color-border-strong)', borderBottom: '1px solid var(--color-border-strong)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 10px', font: '400 11.5px var(--font-mono)', color: 'var(--color-text-body)' }}>{value}{unit ?? ''}</div>
      <button onClick={onInc} style={btn('r')}>+</button>
    </div>
  );
}
