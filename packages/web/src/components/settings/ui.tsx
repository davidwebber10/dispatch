/**
 * Shared presentational primitives for the settings sections, so the desktop page
 * (SettingsView) and the phone's drill-down (MobileSettings) render every section
 * identically. `sectionLabel` is the one heading style; `Toggle` is the one switch.
 */

import { Modal } from '../common/Modal';
import { IconButton } from '../ui/IconButton';
import { Children, useState } from 'react';
import { CaretDown, CaretLeft, CaretRight, type Icon as PhosphorIcon } from '@phosphor-icons/react';
import { fontVar, fontVarInput } from '../../lib/fontSize';

export const sectionLabel: React.CSSProperties = { font: `500 ${fontVar(10)} var(--font-mono)`, letterSpacing: '1.2px', color: 'var(--color-text-tertiary)' };
export const summaryLine: React.CSSProperties = { font: `400 ${fontVar(11)} var(--font-mono)`, color: 'var(--color-text-tertiary)' };
// Buttons (W3-E): a section uses `Button` and `IconButton` from components/ui. `ghostBtn`,
// `solidBtn` and `dangerBtn` stay for plugins (`d.ui.styles`) and for code not yet converted;
// components/ui/ui.css holds the same shapes as classes.
export const ghostBtn: React.CSSProperties = { height: 30, padding: '0 12px', background: 'transparent', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-secondary)', fontSize: fontVar(12), cursor: 'pointer', whiteSpace: 'nowrap' };
export const miniChip: React.CSSProperties = { flexShrink: 0, font: `500 ${fontVar(9.5)} var(--font-mono)`, letterSpacing: '0.6px', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-xs)', padding: '1px 5px' };
export const codeChip: React.CSSProperties = { font: `400 ${fontVar(11)} var(--font-mono)`, color: 'var(--color-text-body)', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)', padding: '1px 5px', whiteSpace: 'nowrap' };
export const fieldInput: React.CSSProperties = { minWidth: 0, height: 30, padding: '0 9px', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-primary)', font: `400 ${fontVar(12)} var(--font-sans)` };
export const solidBtn = (on: boolean): React.CSSProperties => ({ flexShrink: 0, height: 30, padding: '0 14px', background: 'var(--color-accent)', border: 'none', borderRadius: 'var(--radius-sm)', color: 'var(--color-on-accent)', fontWeight: 600, fontSize: fontVar(12.5), cursor: on ? 'pointer' : 'default', opacity: on ? 1 : 0.5 });
export const row: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 };
export const item: React.CSSProperties = { fontSize: fontVar(13), color: 'var(--color-text-body)' };
export const chip: React.CSSProperties = { font: `400 ${fontVar(11.5)} var(--font-mono)`, color: 'var(--color-text-body)', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)', padding: '5px 10px' };
/** A destructive button: the ghost button in red. It always opens a ConfirmModal first. */
export const dangerBtn: React.CSSProperties = { ...ghostBtn, color: 'var(--color-status-red)' };
/** The quiet note under a group or a field (one line, plain words). */
export const noteText: React.CSSProperties = { fontSize: fontVar(11.5), lineHeight: 1.5, color: 'var(--color-text-tertiary)' };
/** A text field's look: the phone gets 16px text (iOS does not zoom) and a 36px box. */
export const fieldFor = (phone: boolean): React.CSSProperties => ({ ...fieldInput, height: phone ? 36 : 30, fontSize: phone ? fontVarInput(16) : fontVar(12.5) });
export const iconBtn: React.CSSProperties = { width: 26, height: 26, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-secondary)', cursor: 'pointer' };

/** This browser's link to the daemon, worded the same in the desktop nav and in Settings → Servers. */
export const CONNECTION_STATUS = {
  open:       { color: 'var(--color-accent)', label: 'Connected' },
  connecting: { color: 'var(--color-status-yellow)', label: 'Reconnecting…' },
  closed:     { color: 'var(--color-status-red)', label: 'Disconnected' },
} as const;

export function Divider() { return <div style={{ height: 1, background: 'var(--color-hover)' }} />; }

export function Toggle({ on, onClick, label, disabled }: { on: boolean; onClick: () => void; label?: string; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} {...(label ? { role: 'switch', 'aria-checked': on, 'aria-label': label } : {})} style={{ width: 38, height: 21, borderRadius: 'var(--radius-lg)', border: 'none', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1, background: on ? 'var(--color-accent)' : 'var(--color-border-hover)', position: 'relative', transition: 'background .15s ease', flexShrink: 0 }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 19 : 2, width: 17, height: 17, borderRadius: '50%', background: on ? 'var(--color-on-accent)' : 'var(--color-text-primary)', transition: 'left .15s ease' }} />
    </button>
  );
}

/**
 * A grouped settings card (2026-11-07): a small heading over a card whose rows are split by a
 * hairline, the shape Settings → Plugins and the phone's Settings list use. `footer` is a quiet
 * note under the card. Falsy children are skipped, so a conditional row needs no wrapper.
 * Plugins get it as `d.ui.SettingsGroup`.
 */
export function SettingsGroup({ title, footer, action, children, style }: { title?: string; footer?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; style?: React.CSSProperties }) {
  const rows = Children.toArray(children).filter((c) => c !== '');
  return (
    <section role="group" aria-label={title} style={{ display: 'flex', flexDirection: 'column', gap: 6, ...style }}>
      {(title || action) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 22, padding: '0 4px' }}>
          {title && <span style={{ ...sectionLabel, textTransform: 'uppercase' }}>{title}</span>}
          {action}
        </div>
      )}
      <div style={{ background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)' }}>
        {rows.map((c, i) => <div key={(c as { key?: string }).key ?? i} style={{ borderTop: i > 0 ? '1px solid var(--color-border)' : 'none' }}>{c as React.ReactNode}</div>)}
      </div>
      {footer && <div style={{ padding: '0 4px', fontSize: fontVar(11.5), lineHeight: 1.5, color: 'var(--color-text-tertiary)' }}>{footer}</div>}
    </section>
  );
}

/**
 * One settings row: the label and a one-line hint on the left, a small control (a switch, a
 * short select, a number) on the right. A wide control (a segmented choice, a list, fields)
 * goes in `children`: it takes its own full-width line under the label, so the text is never
 * squeezed. Plugins get it as `d.ui.SettingsRow`.
 *
 * Variants (2026-11-07, docs/design/settings-layout.md):
 *   - `onClick`: the row opens something (a sub-page, a picker). The whole row is the target and
 *     a chevron ends it; `value` names the current choice before the chevron. A click on `control`
 *     (a switch on the row) does not open the row.
 *   - `value` without `onClick`: a read-only value on the right (a version, a count).
 *   - `danger`: the label is red (a destructive row, at the bottom of the page).
 *   - `icon`: a Phosphor icon in a 32px tile before the label (list rows: plugins, devices).
 */
export function SettingsRow({ label, hint, control, children, style, value, onClick, danger, icon, ariaLabel }: {
  label: React.ReactNode; hint?: React.ReactNode; control?: React.ReactNode; children?: React.ReactNode; style?: React.CSSProperties;
  value?: React.ReactNode; onClick?: () => void; danger?: boolean; icon?: PhosphorIcon;
  /** The row button's accessible name when the label is not plain text. */
  ariaLabel?: string;
}) {
  const hasControl = control !== undefined && control !== null && control !== false;
  const text = (
    <>
      {icon && <IconTile icon={icon} size={32} />}
      <span style={{ flex: 1, minWidth: 0, display: 'block' }}>
        <span style={{ display: 'block', fontSize: fontVar(13.5), color: danger ? 'var(--color-status-red)' : 'var(--color-text-primary)', overflowWrap: 'anywhere' }}>{label}</span>
        {hint && <span style={{ display: 'block', marginTop: 2, fontSize: fontVar(12), lineHeight: 1.4, color: 'var(--color-text-tertiary)' }}>{hint}</span>}
      </span>
      {value !== undefined && value !== null && value !== false && (
        <span style={{ flexShrink: 1, minWidth: 0, maxWidth: '50%', fontSize: fontVar(13), color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
      )}
    </>
  );
  return (
    <div data-testid="settings-row" onClick={onClick} style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '11px 12px', minWidth: 0, cursor: onClick ? 'pointer' : undefined, ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        {onClick ? (
          <button type="button" aria-label={ariaLabel} onClick={(e) => { e.stopPropagation(); onClick(); }}
            style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, padding: 0, background: 'transparent', border: 'none', textAlign: 'left', cursor: 'pointer', color: 'inherit', font: 'inherit' }}>
            {text}
          </button>
        ) : <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12 }}>{text}</div>}
        {hasControl && <div onClick={onClick ? (e) => e.stopPropagation() : undefined} style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>{control}</div>}
        {onClick && <CaretRight data-testid="row-chevron" aria-hidden size={16} color="var(--color-text-tertiary)" style={{ flexShrink: 0 }} />}
      </div>
      {children}
    </div>
  );
}

/** The page shell every section renders: an optional one-line intro, then its groups 20px apart. */
export function SettingsPage({ intro, children, style }: { intro?: React.ReactNode; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div data-testid="settings-page" style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0, ...style }}>
      {intro && <div data-testid="settings-intro" style={{ fontSize: fontVar(13), lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>{intro}</div>}
      {children}
    </div>
  );
}

/** Status tones: the only colors a status may use. */
export const TONE_VAR = { red: 'var(--color-status-red)', yellow: 'var(--color-status-yellow)', accent: 'var(--color-accent)', muted: 'var(--color-text-tertiary)' } as const;
export type Tone = keyof typeof TONE_VAR;

/** A 7px dot in a tone (Plugins' attention mark, a connection state). */
export function ToneDot({ tone, size = 7 }: { tone: Tone; size?: number }) {
  return <span data-testid="tone-dot" aria-hidden style={{ display: 'inline-block', width: size, height: size, borderRadius: '50%', background: TONE_VAR[tone], flexShrink: 0 }} />;
}

/** A status: the dot and one word or a short phrase, in the same tone ("Connected", "Worker crashed"). */
export function StatusMark({ tone, children, style }: { tone: Tone; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <span data-testid="status-mark" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: fontVar(12), color: TONE_VAR[tone], ...style }}>
      <ToneDot tone={tone} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{children}</span>
    </span>
  );
}

/** A Phosphor icon in a rounded square: 32 on a list row, 48 in a sub-page header. */
export function IconTile({ icon: Icon, size = 32, dim }: { icon: PhosphorIcon; size?: number; dim?: boolean }) {
  return (
    <span data-testid="icon-tile" style={{ width: size, height: size, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-md)', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', color: 'var(--color-text-secondary)', opacity: dim ? 0.55 : 1 }}>
      <Icon size={Math.round(size * 0.53)} />
    </span>
  );
}

/**
 * A page pushed from a row (a plugin, an account, a device): a back link (desktop; on the phone
 * the app header carries back, so leave `onBack` out there), a header (icon, title, subtitle,
 * description), then the groups. At most 640px wide.
 */
export function SettingsSubPage({ title, subtitle, description, icon, backLabel, onBack, children, testId, headerTestId }: {
  title: React.ReactNode; subtitle?: React.ReactNode; description?: React.ReactNode; icon?: PhosphorIcon;
  /** The parent's name on the back link ("Plugins"); the button is named "Back to plugins". */
  backLabel?: string; onBack?: () => void; children: React.ReactNode; testId?: string; headerTestId?: string;
}) {
  return (
    <div data-testid={testId ?? 'settings-subpage'} style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 640, width: '100%' }}>
      {onBack && (
        <button type="button" aria-label={`Back to ${(backLabel ?? 'settings').toLowerCase()}`} onClick={onBack} style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 2, padding: '2px 0', background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: fontVar(13), fontWeight: 600 }}>
          <CaretLeft size={15} weight="bold" />{backLabel ?? 'Settings'}
        </button>
      )}
      <div data-testid={headerTestId ?? 'subpage-header'} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        {icon && <IconTile icon={icon} size={48} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: fontVar(18), fontWeight: 600, color: 'var(--color-text-primary)', overflowWrap: 'anywhere' }}>{title}</div>
          {subtitle && <div style={{ marginTop: 2, fontSize: fontVar(12), color: 'var(--color-text-tertiary)' }}>{subtitle}</div>}
          {description && <div style={{ marginTop: 8, fontSize: fontVar(13), lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>{description}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

/**
 * Rows folded behind one row (Developer, Advanced): a card whose first row says what is inside
 * and turns a caret; the rows show under it when open.
 */
export function SettingsDisclosure({ label, hint, defaultOpen = false, children, testId }: { label: string; hint?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode; testId?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const rows = Children.toArray(children).filter((c) => c !== '');
  return (
    <div data-testid={testId} style={{ background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)' }}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '11px 12px', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', color: 'inherit', font: 'inherit' }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: fontVar(13.5), color: 'var(--color-text-primary)' }}>{label}</span>
          {hint && <span style={{ display: 'block', marginTop: 2, fontSize: fontVar(12), color: 'var(--color-text-tertiary)' }}>{hint}</span>}
        </span>
        <CaretDown aria-hidden size={16} color="var(--color-text-tertiary)" style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 120ms' }} />
      </button>
      {open && rows.map((c, i) => <div key={(c as { key?: string }).key ?? i} style={{ borderTop: '1px solid var(--color-border)' }}>{c as React.ReactNode}</div>)}
    </div>
  );
}

/**
 * What a list shows when it has nothing (the shape of Plugins' "No local plugins."): one or two
 * plain sentences in place of the card, with the action that fills it. No card, no icon.
 */
export function EmptyState({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div data-testid="empty-state" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '0 4px' }}>
      <span style={{ flex: 1, minWidth: 180, fontSize: fontVar(12.5), lineHeight: 1.5, color: 'var(--color-text-tertiary)' }}>{children}</span>
      {action}
    </div>
  );
}

export function GroupHeader({ label, count, tone = 'neutral', hint }: { label: string; count?: number; tone?: 'accent' | 'red' | 'neutral'; hint?: string }) {
  const color = tone === 'accent' ? 'var(--color-accent)' : tone === 'red' ? 'var(--color-status-red)' : 'var(--color-text-tertiary)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
      <span style={{ font: `600 ${fontVar(9.5)} var(--font-mono)`, letterSpacing: '1.2px', textTransform: 'uppercase', color, flexShrink: 0 }}>{label}</span>
      {count !== undefined && <span style={{ font: `400 ${fontVar(9.5)} var(--font-mono)`, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>{count}</span>}
      <span style={{ flex: 1, height: 1, background: 'var(--color-hover)' }} />
      {hint && <span style={{ fontSize: fontVar(10.5), color: 'var(--color-text-tertiary)', flexShrink: 0 }}>{hint}</span>}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder, style }: { value: string; onChange: (v: string) => void; placeholder: string; style?: React.CSSProperties }) {
  return (
    <span style={{ position: 'relative', display: 'flex', flex: 1, minWidth: 0, ...style }}>
      <span aria-hidden style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', font: `400 ${fontVar(11)} var(--font-mono)`, color: 'var(--color-text-tertiary)', pointerEvents: 'none' }}>/</span>
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
            style={{ height: 28, padding: '0 10px', background: on ? 'var(--color-hover)' : 'transparent', border: 'none', borderLeft: idx > 0 ? '1px solid var(--color-border-strong)' : 'none', color: on ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)', font: `500 ${fontVar(11)} var(--font-mono)`, cursor: 'pointer', whiteSpace: 'nowrap' }}>
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
    <IconButton label={title} size="sm" icon={children} onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ color }} />
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
  const btn = (side: 'l' | 'r'): React.CSSProperties => ({ width: 28, height: 28, background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: side === 'l' ? 'var(--radius-sm) 0 0 var(--radius-sm)' : '0 var(--radius-sm) var(--radius-sm) 0', color: 'var(--color-text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', font: `500 ${fontVar(14)} var(--font-sans)` });
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <button onClick={onDec} style={btn('l')}>−</button>
      <div style={{ height: 28, minWidth: 64, background: 'var(--color-elevated)', borderTop: '1px solid var(--color-border-strong)', borderBottom: '1px solid var(--color-border-strong)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 10px', font: `400 ${fontVar(11.5)} var(--font-mono)`, color: 'var(--color-text-body)' }}>{value}{unit ?? ''}</div>
      <button onClick={onInc} style={btn('r')}>+</button>
    </div>
  );
}

/** A native range slider with its value and a reset button. The reset button is disabled at `defaultValue` (0 unless told otherwise). */
export function Slider({ value, min, max, step, label, display, onChange, onReset, defaultValue = 0 }: { value: number; min: number; max: number; step: number; label: string; display: string; onChange: (v: number) => void; onReset: () => void; defaultValue?: number }) {
  const atDefault = value === defaultValue;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: 160, maxWidth: '40vw', accentColor: 'var(--color-accent)', cursor: 'pointer' }} />
      <div style={{ height: 28, minWidth: 52, background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 8px', font: `400 ${fontVar(11.5)} var(--font-mono)`, color: 'var(--color-text-body)' }}>{display}</div>
      <button type="button" aria-label={`Reset ${label}`} title={`Reset ${label}`} disabled={atDefault} onClick={onReset} style={{ ...iconBtn, width: 28, height: 28, font: `500 ${fontVar(14)} var(--font-sans)`, cursor: atDefault ? 'default' : 'pointer', opacity: atDefault ? 0.4 : 1 }}>↺</button>
    </div>
  );
}
