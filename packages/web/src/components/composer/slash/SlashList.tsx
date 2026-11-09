import type { CSSProperties } from 'react';

/** One line in the "/" menu: a command, or (after `/model `) a model or effort to pick. */
export interface SlashItem {
  key: string;
  /** What is typed or shown first: `/model`, `Opus`, `high`. */
  label: string;
  description?: string;
  /** Greyed, with this as the reason; choosing it does nothing. */
  disabledReason?: string;
  /** The saved choice: shown with a mark. */
  current?: boolean;
  run: () => void;
  /** Enter on a command that is typed out in full (`/model`): do this instead of `run`. */
  runExact?: () => void;
}

export const ESCAPE_NOTE = 'To send a message that starts with /, put a space before it.';

/**
 * The list itself, for the popup above the composer (desktop) and the Commands sheet (phone).
 * It only draws: the hook owns the keys and the active line. Mouse down is kept from taking the
 * focus away from the text box, so the caret and the keyboard stay put.
 */
export function SlashList({ items, active, onHover, mobile, footer = true }: {
  items: SlashItem[];
  active: number;
  onHover?: (i: number) => void;
  mobile?: boolean;
  footer?: boolean;
}) {
  const row = (isActive: boolean, disabled: boolean): CSSProperties => ({
    display: 'flex', alignItems: 'baseline', gap: 10, width: '100%', padding: mobile ? '12px 12px' : '6px 10px', border: 'none', borderRadius: 'var(--radius-md)',
    background: isActive && !disabled ? 'var(--color-hover)' : 'none', textAlign: 'left',
    color: disabled ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)', cursor: disabled ? 'default' : 'pointer', font: `500 ${mobile ? 15 : 13}px var(--font-sans)`,
  });
  return (
    <div role="listbox" aria-label="Commands" style={{ display: 'flex', flexDirection: 'column' }}>
      {items.map((it, i) => (
        <button
          key={it.key}
          type="button"
          role="option"
          aria-selected={i === active}
          aria-disabled={!!it.disabledReason}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover?.(i)}
          onClick={() => { if (!it.disabledReason) it.run(); }}
          style={row(i === active, !!it.disabledReason)}
        >
          <span style={{ font: '600 13px var(--font-mono)', flex: 'none' }}>{it.label}</span>
          <span style={{ flex: 1, minWidth: 0, font: '400 12px var(--font-sans)', color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {it.disabledReason ?? it.description}
          </span>
          {it.current && <span style={{ font: '400 11px var(--font-mono)', color: 'var(--color-accent)' }}>current</span>}
        </button>
      ))}
      {footer && <div style={{ padding: '6px 10px 2px', font: '400 11px var(--font-sans)', color: 'var(--color-text-tertiary)' }}>{ESCAPE_NOTE}</div>}
    </div>
  );
}
