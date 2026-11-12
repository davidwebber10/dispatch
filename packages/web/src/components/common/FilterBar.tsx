import { useEffect, useState, type ReactNode } from 'react';
import { CaretDown, Check, FunnelSimple, MagnifyingGlass, X } from '@phosphor-icons/react';
import { Modal } from './Modal';
import { useIsMobile } from '../../hooks/useIsMobile';
import { fontVar, fontVarInput } from '../../lib/fontSize';

export interface FilterOption {
  value: string;
  label: string;
  /** A quiet second word on the row (the harness of a model, the provider of an account). */
  note?: string;
  /** How many items this choice leaves. Omitted, no count shows. */
  count?: number;
}

export interface FilterFacet {
  id: string;
  /** The section's heading and the pill's prefix: "Project". */
  title: string;
  /** The current pick; null is "no filter" (the All row). */
  value: string | null;
  options: FilterOption[];
  onChange(value: string | null): void;
  /** The All row's label. Default "All". */
  allLabel?: string;
  allCount?: number;
  /** `segmented`: a row of radio buttons, All last (for two or three choices). Default `list`. */
  display?: 'list' | 'segmented';
  /** A search box inside the section. Default: on past 8 options. */
  searchable?: boolean;
  /** Whether the section starts unfolded. Default: when it has a pick, or when there are 2 facets or fewer. */
  defaultOpen?: boolean;
}

export interface FilterBarProps {
  facets: FilterFacet[];
  /** The search field. Without `onQueryChange` there is none. */
  query?: string;
  onQueryChange?(query: string): void;
  placeholder?: string;
  /** Takes the search's place left of the button (the phone's ACTIVE / ARCHIVED tabs). */
  leading?: ReactNode;
  /** Called by Clear after every facet is reset (to reset state the facets don't hold). */
  onClear?(): void;
  /** The panel footer's close button. Default "Done"; "Show 12 threads" says what a pick leaves. */
  doneLabel?: string;
  /** `popover` under the button (desktop) or a bottom `sheet` (phone). Default by screen width. */
  variant?: 'popover' | 'sheet';
  /** `lg` is the phone size (36px row, 16px search text so iOS does not zoom). Default by screen width. */
  size?: 'md' | 'lg';
  style?: React.CSSProperties;
  rowStyle?: React.CSSProperties;
  pillsStyle?: React.CSSProperties;
  rowTestId?: string;
}

/**
 * The app's one filter control (2026-11-07): a search field with a Filters button to its right;
 * the button opens a panel (a popover on the desktop, a bottom sheet on the phone) with one
 * section per facet, each a single-select list. While the panel is closed, the active filters
 * show as pills under the row, each with ×, and Clear. Derived from the Threads list's filters;
 * the Threads list (desktop and phone) and the Previews plugin (`d.ui.FilterBar`) use it.
 */
export function FilterBar({ facets, query = '', onQueryChange, placeholder = 'Search', leading, onClear, doneLabel = 'Done', variant, size, style, rowStyle, pillsStyle, rowTestId }: FilterBarProps) {
  const isMobile = useIsMobile();
  const sheet = (variant ?? (isMobile ? 'sheet' : 'popover')) === 'sheet';
  const lg = (size ?? (isMobile ? 'lg' : 'md')) === 'lg';
  const [open, setOpen] = useState(false);
  const on = facets.filter((f) => f.value !== null);
  const n = on.length;
  const clear = () => { for (const f of facets) if (f.value !== null) f.onChange(null); onClear?.(); };
  const labelOf = (f: FilterFacet) => f.options.find((o) => o.value === f.value)?.label ?? f.value ?? f.allLabel ?? 'All';

  useEffect(() => {
    if (!open || sheet) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, sheet]);

  const h = lg ? 36 : 32;
  const button = (
    <button type="button" aria-expanded={open} aria-haspopup="dialog" aria-label={n ? `Filters, ${n} on` : 'Filters'} onClick={() => setOpen((v) => !v)}
      style={{
        height: h, padding: '0 10px', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
        fontSize: fontVar(lg ? 14 : 13), borderRadius: lg ? 'var(--radius-md)' : 'var(--radius-sm)',
        border: `1px solid ${n ? 'color-mix(in srgb, var(--color-accent) 55%, transparent)' : 'var(--color-border-strong)'}`,
        background: n || open ? 'color-mix(in srgb, var(--color-accent) 10%, var(--color-elevated))' : 'var(--color-elevated)',
        color: n ? 'var(--color-accent)' : 'var(--color-text-secondary)',
      }}>
      <FunnelSimple size={lg ? 16 : 15} weight="bold" />Filters
      {n > 0 && <span aria-hidden style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 'var(--radius-pill)', background: 'var(--color-accent)', color: 'var(--color-on-accent)', font: `600 ${fontVar(11)} var(--font-sans)`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{n}</span>}
    </button>
  );

  const body = (
    <div data-testid="filters-panel" style={{ display: 'flex', flexDirection: 'column', margin: sheet ? '0 -4px' : 0 }}>
      {facets.map((f) => <Section key={f.id} facet={f} few={facets.length <= 2} lg={lg} />)}
      <div style={{ position: 'sticky', bottom: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderTop: '1px solid var(--color-border)', background: 'var(--color-elevated)' }}>
        <button type="button" onClick={clear} disabled={!n} style={{ background: 'none', border: 'none', padding: 0, fontSize: fontVar(13), color: 'var(--color-text-secondary)', cursor: n ? 'pointer' : 'default', opacity: n ? 1 : 0.5 }}>Clear</button>
        <button type="button" onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', padding: 0, fontSize: fontVar(13.5), fontWeight: 500, color: 'var(--color-accent)', cursor: 'pointer' }}>{doneLabel}</button>
      </div>
    </div>
  );

  const pill: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 4px 0 10px', flexShrink: 0, maxWidth: 240,
    borderRadius: 'var(--radius-pill)', fontSize: fontVar(13), color: 'var(--color-text-primary)',
    background: 'color-mix(in srgb, var(--color-accent) 12%, var(--color-elevated))', border: '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0, ...style }}>
      <div data-filterbar-row="" data-testid={rowTestId} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, ...rowStyle }}>
        {onQueryChange && (
          <span style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex' }}>
            <MagnifyingGlass aria-hidden size={lg ? 16 : 14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-tertiary)', pointerEvents: 'none' }} />
            <input type="search" role="searchbox" aria-label={placeholder} placeholder={placeholder} value={query} onChange={(e) => onQueryChange(e.target.value)}
              style={{ flex: 1, minWidth: 0, height: h, padding: `0 10px 0 ${lg ? 32 : 30}px`, background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: lg ? 'var(--radius-md)' : 'var(--radius-sm)', color: 'var(--color-text-primary)', fontSize: lg ? fontVarInput(16) : fontVar(13), boxSizing: 'border-box' }} />
          </span>
        )}
        {!onQueryChange && leading}
        <span style={{ display: 'flex', flexShrink: 0, marginLeft: onQueryChange || leading ? undefined : 'auto' }}>{button}</span>
        {/* Anchored to the row, not the button, so a narrow row (the desktop's left panel) keeps the
            whole panel inside it: right-aligned, never wider than the row. */}
        {open && !sheet && <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
          <div role="dialog" aria-label="Filters" data-variant="popover" style={{ position: 'absolute', top: h + 6, right: 0, zIndex: 91, width: 300, maxWidth: '100%', boxSizing: 'border-box', maxHeight: '65vh', overflowY: 'auto', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', boxShadow: '0 20px 50px -20px var(--color-shadow-strong)' }}>
            {body}
          </div>
        </>}
      </div>
      {n > 0 && !open && (
        <div data-testid="applied-filters" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', ...pillsStyle }}>
          {on.map((f) => (
            <span key={f.id} style={pill}>
              <span style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }}>{f.title}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{labelOf(f)}</span>
              <button type="button" aria-label={`Remove ${f.title} filter`} onClick={() => f.onChange(null)} style={{ display: 'inline-flex', width: 20, height: 20, flexShrink: 0, alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', padding: 0 }}>
                <X size={12} weight="bold" />
              </button>
            </span>
          ))}
          <button type="button" onClick={clear} style={{ background: 'none', border: 'none', color: 'var(--color-text-secondary)', fontSize: fontVar(12.5), cursor: 'pointer', padding: '0 4px' }}>Clear</button>
        </div>
      )}
      {sheet && <Modal open={open} sheet title="Filters" onClose={() => setOpen(false)}>{body}</Modal>}
    </div>
  );
}

/** One facet in the panel: a header that names the current pick, and the choices under it when unfolded. */
function Section({ facet: f, few, lg }: { facet: FilterFacet; few: boolean; lg: boolean }) {
  const [open, setOpen] = useState(() => f.defaultOpen ?? (few || f.value !== null));
  const [q, setQ] = useState('');
  const allLabel = f.allLabel ?? 'All';
  const summary = f.value === null ? allLabel : f.options.find((o) => o.value === f.value)?.label ?? f.value;
  const searchable = f.display !== 'segmented' && (f.searchable ?? f.options.length > 8);
  const needle = q.trim().toLowerCase();
  // The picked option always stays, even when the search would hide it.
  const shown = needle ? f.options.filter((o) => o.value === f.value || `${o.label} ${o.note ?? ''}`.toLowerCase().includes(needle)) : f.options;
  const row = (value: string | null, label: string, note?: string, count?: number) => {
    const pressed = f.value === value;
    return (
      <button key={value ?? '__all__'} type="button" aria-pressed={pressed} aria-label={label} onClick={() => f.onChange(value)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: lg ? 44 : 36, padding: '0 12px 0 14px', border: 'none', cursor: 'pointer', textAlign: 'left', fontSize: fontVar(lg ? 14 : 13),
          background: pressed ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)' : 'transparent', color: pressed ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
        }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {note && <span aria-hidden style={{ fontSize: fontVar(12), color: 'var(--color-text-tertiary)', flexShrink: 0 }}>{note}</span>}
        {count !== undefined && <span aria-hidden style={{ font: `400 ${fontVar(12)} var(--font-mono)`, color: 'var(--color-text-tertiary)', fontVariantNumeric: 'tabular-nums', minWidth: 22, textAlign: 'right' }}>{count}</span>}
        <span aria-hidden style={{ width: 16, display: 'inline-flex', justifyContent: 'center', color: 'var(--color-accent)' }}>{pressed && <Check size={14} weight="bold" />}</span>
      </button>
    );
  };
  return (
    <section style={{ borderBottom: '1px solid var(--color-border)' }}>
      <button type="button" aria-expanded={open} aria-label={`${f.title}: ${summary}`} onClick={() => setOpen((v) => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: lg ? 46 : 40, padding: '0 12px 0 14px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
        <span style={{ fontSize: fontVar(lg ? 14.5 : 13.5), fontWeight: 600, color: 'var(--color-text-primary)', flexShrink: 0 }}>{f.title}</span>
        <span style={{ flex: 1, minWidth: 0, textAlign: 'right', fontSize: fontVar(lg ? 13.5 : 12.5), color: f.value !== null ? 'var(--color-accent)' : 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
        <CaretDown size={14} weight="bold" style={{ color: 'var(--color-text-tertiary)', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 120ms' }} />
      </button>
      {open && f.display === 'segmented' && (
        <div role="radiogroup" aria-label={f.title} style={{ display: 'flex', gap: 2, padding: 2, margin: '2px 12px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'var(--color-base)' }}>
          {[...f.options, { value: null as string | null, label: allLabel, count: f.allCount }].map((o) => {
            const checked = f.value === o.value;
            return (
              <button key={o.value ?? '__all__'} type="button" role="radio" aria-checked={checked} onClick={() => f.onChange(o.value)}
                style={{ flex: '1 1 auto', height: 30, padding: '0 4px', whiteSpace: 'nowrap', border: 'none', cursor: 'pointer', borderRadius: 'var(--radius-sm)', fontSize: fontVar(13.5), background: checked ? 'var(--color-hover)' : 'transparent', color: checked ? 'var(--color-text-primary)' : 'var(--color-text-secondary)' }}>
                {o.label}{o.count !== undefined && <> <span style={{ color: 'var(--color-text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>{o.count}</span></>}
              </button>
            );
          })}
        </div>
      )}
      {open && f.display !== 'segmented' && (
        <div role="group" aria-label={`${f.title} filter`} style={{ display: 'flex', flexDirection: 'column', paddingBottom: 6 }}>
          {searchable && (
            <input type="search" role="searchbox" aria-label={`Search ${f.title.toLowerCase()}`} placeholder={`Search ${f.title.toLowerCase()}`} value={q} onChange={(e) => setQ(e.target.value)}
              style={{ margin: '0 12px 6px 14px', height: lg ? 36 : 30, padding: '0 10px', background: 'var(--color-base)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-primary)', fontSize: lg ? fontVarInput(16) : fontVar(13), boxSizing: 'border-box' }} />
          )}
          {row(null, allLabel, undefined, f.allCount)}
          {shown.map((o) => row(o.value, o.label, o.note, o.count))}
          {needle && !shown.length && <div style={{ padding: '8px 14px', fontSize: fontVar(13), color: 'var(--color-text-tertiary)' }}>No matches</div>}
        </div>
      )}
    </section>
  );
}
