import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaretUpDown, Check, MagnifyingGlass } from '@phosphor-icons/react';
import { Modal } from './Modal';
import { useIsMobile } from '../../hooks/useIsMobile';

export interface MultiSelectOption {
  value: string;
  label: string;
  /** A quiet second word on the row. */
  note?: string;
}

interface SummaryWords {
  /** The words for every option picked. Default "All". */
  allLabel?: string;
  /** The words for none picked. Default "None". */
  noneLabel?: string;
  /** `['project', 'projects']` makes "3 projects"; without it, "3 selected". */
  noun?: [string, string];
}

/**
 * The trigger's words for a pick: all, none, "All except 2" when fewer are off than on, else
 * "3 projects" (or "3 selected"). Values that are not among the options do not count.
 */
export function multiSummary(value: string[], all: string[], w: SummaryWords): string {
  const known = new Set(all);
  const n = new Set(value.filter((v) => known.has(v))).size;
  const total = known.size;
  if (n === 0) return w.noneLabel ?? 'None';
  if (n === total) return w.allLabel ?? 'All';
  const off = total - n;
  if (off < n) return `All except ${off}`;
  return w.noun ? `${n} ${n === 1 ? w.noun[0] : w.noun[1]}` : `${n} selected`;
}

export interface MultiSelectProps extends SummaryWords {
  value: string[];
  options: MultiSelectOption[];
  onChange(value: string[]): void;
  /** The trigger's accessible name ("Projects"); the trigger reads "Projects: All except 2". */
  ariaLabel: string;
  /** The panel's heading. Default `ariaLabel`. */
  title?: string;
  /** The trigger's words; default from `multiSummary`. */
  summary?: string;
  /** The search box over the list. Default: on past 8 options. */
  searchable?: boolean;
  /** Default by screen width: `popover` on the desktop, `sheet` on the phone. */
  variant?: 'popover' | 'sheet';
  style?: React.CSSProperties;
  disabled?: boolean;
}

/**
 * The app's multi-pick (2026-11-07): a small trigger that names the pick ("All projects",
 * "All except 2", "3 projects") and opens a panel (a popover on the desktop, the shared bottom
 * sheet on the phone) with a search box, Select all / None, and a scrolling checklist. Each tap
 * calls `onChange` at once with the new list; values that are not among the options are kept.
 * Select all and None act on the rows the search shows. Plugins get it as `d.ui.MultiSelect`.
 */
export function MultiSelect({ value, options, onChange, ariaLabel, title, summary, searchable, variant, style, disabled, ...wordOpts }: MultiSelectProps) {
  const isMobile = useIsMobile();
  const sheet = (variant ?? (isMobile ? 'sheet' : 'popover')) === 'sheet';
  const lg = isMobile || sheet;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const heading = title ?? ariaLabel;
  const words = summary ?? multiSummary(value, options.map((o) => o.value), wordOpts);
  const picked = new Set(value);
  const canSearch = searchable ?? options.length > 8;
  const needle = q.trim().toLowerCase();
  const shown = needle ? options.filter((o) => `${o.label} ${o.note ?? ''}`.toLowerCase().includes(needle)) : options;
  const nPicked = options.filter((o) => picked.has(o.value)).length;

  /** The new list: unknown values first (kept as they were), then the options in their order. */
  const emit = (next: Set<string>) => {
    const known = new Set(options.map((o) => o.value));
    onChange([...value.filter((v) => !known.has(v)), ...options.filter((o) => next.has(o.value)).map((o) => o.value)]);
  };
  const toggle = (v: string) => { const s = new Set(picked); if (s.has(v)) s.delete(v); else s.add(v); emit(s); };
  const pickShown = (on: boolean) => { const s = new Set(picked); for (const o of shown) { if (on) s.add(o.value); else s.delete(o.value); } emit(s); };
  const close = () => { setOpen(false); triggerRef.current?.focus({ preventScroll: true }); };

  useLayoutEffect(() => {
    if (!open || sheet) return;
    const place = (event?: Event) => {
      if (event?.target instanceof Node && popRef.current?.contains(event.target)) return;
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const vw = window.innerWidth; const vh = window.innerHeight;
      const width = Math.min(320, vw - 16);
      const left = Math.max(8, Math.min(r.right - width, vw - 8 - width));
      const below = vh - r.bottom - 12;
      const above = r.top - 12;
      if (below >= 300 || below >= above) setPos({ top: r.bottom + 4, left, width, maxHeight: Math.max(200, Math.min(440, below)) });
      else setPos({ bottom: vh - r.top + 4, left, width, maxHeight: Math.max(200, Math.min(440, above)) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, sheet]);

  useEffect(() => {
    if (!open || sheet) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown); };
  }, [open, sheet]);

  const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: '4px 2px', fontSize: lg ? 13.5 : 12.5, color: 'var(--color-accent)', cursor: 'pointer' };
  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, margin: sheet ? '0 -4px' : 0 }}>
      {canSearch && (
        <span style={{ position: 'relative', display: 'flex', margin: sheet ? '0 0 8px' : '10px 10px 6px' }}>
          <MagnifyingGlass aria-hidden size={lg ? 16 : 14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-tertiary)', pointerEvents: 'none' }} />
          <input type="search" role="searchbox" aria-label={`Search ${heading.toLowerCase()}`} placeholder={`Search ${heading.toLowerCase()}`} value={q} onChange={(e) => setQ(e.target.value)}
            autoComplete="off" spellCheck={false}
            style={{ flex: 1, minWidth: 0, height: lg ? 38 : 30, padding: `0 10px 0 ${lg ? 32 : 30}px`, background: 'var(--color-base)', border: '1px solid var(--color-border)', borderRadius: lg ? 'var(--radius-md)' : 'var(--radius-sm)', color: 'var(--color-text-primary)', fontSize: lg ? 16 : 13, boxSizing: 'border-box' }} />
        </span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: sheet ? '0 2px 6px' : '2px 12px 6px', borderBottom: '1px solid var(--color-border)' }}>
        <button type="button" onClick={() => pickShown(true)} style={linkBtn}>Select all</button>
        <button type="button" onClick={() => pickShown(false)} style={linkBtn}>None</button>
        <span style={{ marginLeft: 'auto', font: '400 11.5px var(--font-mono)', color: 'var(--color-text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>{nPicked} of {options.length}</span>
      </div>
      <div role="group" aria-label={heading} style={{ overflowY: 'auto', overscrollBehavior: 'contain', minHeight: 0, flex: 1, maxHeight: sheet ? '55vh' : undefined, padding: '4px 0' }}>
        {shown.map((o) => {
          const on = picked.has(o.value);
          return (
            <button key={o.value} type="button" role="checkbox" aria-checked={on} aria-label={o.label} onClick={() => toggle(o.value)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: lg ? 44 : 34, padding: sheet ? '0 6px' : '0 12px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', fontSize: lg ? 14.5 : 13, color: on ? 'var(--color-text-primary)' : 'var(--color-text-secondary)' }}>
              <span aria-hidden style={{ width: 18, height: 18, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-xs)', border: `1.5px solid ${on ? 'var(--color-accent)' : 'var(--color-border-hover)'}`, background: on ? 'var(--color-accent)' : 'transparent', color: 'var(--color-on-accent)' }}>
                {on && <Check size={12} weight="bold" />}
              </span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
              {o.note && <span aria-hidden style={{ fontSize: 12, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>{o.note}</span>}
            </button>
          );
        })}
        {needle && !shown.length && <div style={{ padding: '10px 12px', fontSize: 13, color: 'var(--color-text-tertiary)' }}>No matches</div>}
      </div>
      {!sheet && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 12px', borderTop: '1px solid var(--color-border)' }}>
          <button type="button" onClick={close} style={{ ...linkBtn, fontWeight: 500 }}>Done</button>
        </div>
      )}
      {sheet && (
        <button type="button" onClick={close} style={{ marginTop: 10, height: 44, border: 'none', borderRadius: 'var(--radius-md)', background: 'var(--color-accent)', color: 'var(--color-on-accent)', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Done</button>
      )}
    </div>
  );

  return (
    <>
      <button ref={triggerRef} type="button" aria-haspopup="dialog" aria-expanded={open} aria-label={`${ariaLabel}: ${words}`} disabled={disabled}
        onClick={() => { if (open) setOpen(false); else { setQ(''); setOpen(true); } }}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', height: lg ? 36 : 30, padding: '0 8px 0 10px', cursor: disabled ? 'default' : 'pointer',
          background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: lg ? 'var(--radius-md)' : 'var(--radius-sm)',
          color: 'var(--color-text-primary)', fontSize: lg ? 14 : 12.5, fontWeight: 500, opacity: disabled ? 0.5 : 1, ...style,
        }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{words}</span>
        <CaretUpDown aria-hidden size={14} style={{ flexShrink: 0, color: 'var(--color-text-tertiary)' }} />
      </button>
      {open && !sheet && createPortal(
        <div ref={popRef} role="dialog" aria-label={heading} style={{
          position: 'fixed', zIndex: 1000, ...(pos ?? { top: 0, left: 0, width: 320, maxHeight: 440 }),
          display: 'flex', flexDirection: 'column', overflow: 'hidden', boxSizing: 'border-box',
          background: 'var(--color-modal)', border: '1px solid var(--color-border-hover)', borderRadius: 'var(--radius-lg)', boxShadow: '0 20px 50px -12px var(--color-shadow-strong)',
        }}>
          {body}
        </div>,
        document.body,
      )}
      {sheet && <Modal open={open} sheet title={heading} onClose={close}>{body}</Modal>}
    </>
  );
}
