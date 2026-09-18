import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface SearchSelectOption {
  value: string;
  label: string;
  /** Muted second line — a model id, a context size. Searched too. */
  hint?: string;
}

/**
 * A select with a search box: the trigger reads like a native `<select>`, the popover
 * lists the options under a filter input. Built for model lists that outgrow a plain
 * dropdown (OpenCode's OpenRouter list) but used for every model picker so they all
 * behave the same.
 *
 * Accessibility: the trigger is a `combobox` named by `ariaLabel`; the popover holds a
 * search `textbox` and a `listbox` of `option`s. Arrow keys move, Enter picks, Escape
 * closes (and does NOT bubble — the enclosing modal also closes on Escape).
 *
 * The popover is portaled and fixed-positioned from the trigger's rect, flipping above
 * when there is no room below, so it escapes any clipping ancestor (the modal card, the
 * phone sheet). It closes on outside click, scroll, and resize rather than tracking.
 */
export function SearchSelect({ value, options, onChange, ariaLabel, size = 'md', style, disabled, emptyText = 'No matches', searchPlaceholder = 'Search…' }: {
  value: string;
  options: SearchSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  /** `lg` is the phone size: 40px trigger, 44px rows. */
  size?: 'md' | 'lg';
  style?: React.CSSProperties;
  disabled?: boolean;
  emptyText?: string;
  searchPlaceholder?: string;
}) {
  const lg = size === 'lg';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const current = options.find((o) => o.value === value);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => `${o.label} ${o.value} ${o.hint ?? ''}`.toLowerCase().includes(q));
  }, [options, query]);

  // Every open starts fresh: empty filter, cursor on the current value.
  function show() {
    if (disabled) return;
    setQuery('');
    const idx = options.findIndex((o) => o.value === value);
    setActive(idx < 0 ? 0 : idx);
    setOpen(true);
  }
  function hide() { setOpen(false); triggerRef.current?.focus(); }
  function pick(v: string) { onChange(v); setOpen(false); triggerRef.current?.focus(); }

  // Place the popover from the trigger's rect. Below by default; above when the space
  // below is short. Width: the trigger's, but never narrower than a readable list.
  useLayoutEffect(() => {
    if (!open) return;
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(r.width, 260);
    const left = Math.min(Math.max(8, r.right - width), Math.max(8, window.innerWidth - width - 8));
    const wanted = 320;
    const below = window.innerHeight - r.bottom;
    if (below < wanted && r.top > below) setPos({ bottom: window.innerHeight - r.top + 4, left, width });
    else setPos({ top: r.bottom + 4, left, width });
    inputRef.current?.focus();
  }, [open]);

  // Outside click / scroll / resize close it. `mousedown` (not click) so the option's
  // own click still lands before the popover unmounts.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onAway = (e: Event) => {
      // Scrolling the options (including keyboard scrollIntoView) keeps them open.
      if (e.target instanceof Node && popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onAway);
    window.addEventListener('scroll', onAway, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onAway);
      window.removeEventListener('scroll', onAway, true);
    };
  }, [open]);

  // Keep the cursor inside the filtered list as the query changes.
  useEffect(() => { setActive((a) => Math.min(a, Math.max(0, filtered.length - 1))); }, [filtered.length]);

  // Scroll the active row into view as the keyboard moves it.
  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); hide(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); return; }
    if (e.key === 'Enter') { e.preventDefault(); const o = filtered[active]; if (o) pick(o.value); return; }
    if (e.key === 'Tab') setOpen(false);
  }

  const field: React.CSSProperties = {
    background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: lg ? 9 : 7,
    color: 'var(--color-text-primary)', boxSizing: 'border-box',
  };

  return (
    <>
      <button ref={triggerRef} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} aria-label={ariaLabel}
        disabled={disabled} onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); show(); } }}
        style={{
          ...field, height: lg ? 40 : 32, width: '100%', padding: lg ? '0 30px 0 12px' : '0 26px 0 10px',
          fontSize: lg ? 14 : 12.5, fontWeight: 500, cursor: disabled ? 'default' : 'pointer', textAlign: 'left',
          position: 'relative', display: 'flex', alignItems: 'center', opacity: disabled ? 0.5 : 1, ...style,
        }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, color: current ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)' }}>
          {current?.label ?? (options.length ? 'Choose…' : '—')}
        </span>
        <span aria-hidden="true" style={{ position: 'absolute', right: lg ? 13 : 10, top: lg ? 14 : 11, width: 7, height: 7, borderRight: '1.5px solid var(--color-text-secondary)', borderBottom: '1.5px solid var(--color-text-secondary)', transform: 'rotate(45deg)', pointerEvents: 'none' }} />
      </button>

      {open && createPortal(
        <div ref={popRef} onKeyDown={onKey} style={{
          position: 'fixed', zIndex: 1000, ...(pos ?? { top: 0, left: 0, width: 260 }),
          background: '#18181B', border: '1px solid #2F2F35', borderRadius: 10, boxShadow: '0 20px 50px -12px rgba(0,0,0,.8)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <input ref={inputRef} value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} placeholder={searchPlaceholder}
            aria-label={`Search ${ariaLabel.toLowerCase()}`} aria-controls={listId} aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
            autoComplete="off" spellCheck={false}
            style={{ ...field, border: 'none', borderBottom: '1px solid #26262B', borderRadius: 0, height: lg ? 44 : 36, padding: '0 12px', fontSize: lg ? 15 : 13, background: 'transparent', outline: 'none' }} />
          <ul id={listId} role="listbox" aria-label={ariaLabel} style={{ listStyle: 'none', margin: 0, padding: 4, maxHeight: lg ? 264 : 240, overflowY: 'auto' }}>
            {filtered.length === 0 && (
              <li aria-disabled="true" style={{ padding: '10px 12px', fontSize: lg ? 14 : 12.5, color: 'var(--color-text-tertiary)' }}>{emptyText}</li>
            )}
            {filtered.map((o, i) => {
              const selected = o.value === value;
              const hot = i === active;
              return (
                <li key={o.value} id={`${listId}-${i}`} data-index={i} role="option" aria-selected={selected}
                  onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o.value)}
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 1, justifyContent: 'center', minHeight: lg ? 44 : 32, padding: lg ? '6px 12px' : '5px 10px',
                    borderRadius: 6, cursor: 'pointer',
                    background: hot ? 'color-mix(in srgb, var(--color-accent) 12%, var(--color-elevated))' : 'transparent',
                    color: selected ? 'var(--color-accent)' : 'var(--color-text-primary)',
                  }}>
                  <span style={{ fontSize: lg ? 14 : 12.5, fontWeight: selected ? 600 : 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}</span>
                  {o.hint && <span style={{ font: `400 ${lg ? 11 : 10.5}px var(--font-mono)`, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.hint}</span>}
                </li>
              );
            })}
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
}
