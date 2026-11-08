import { useIsMobile } from '../../hooks/useIsMobile';

export interface SegmentedOption {
  value: string;
  label: string;
  /** One short line that shows under the control while this option is picked. */
  hint?: string;
}

/**
 * The app's segmented control (2026-11-07): one radiogroup of 2 to 5 equal-width segments that
 * takes the full width of its line. Put it on its own line under a setting's label and hint, not
 * beside them, so the text never gets squeezed. The picked option's `hint` shows under it.
 * Plugins get it as `d.ui.Segmented`.
 */
export function Segmented({ value, options, onChange, ariaLabel, size, style }: {
  value: string;
  options: SegmentedOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  /** `lg` is the phone size (36px). Default by screen width. */
  size?: 'md' | 'lg';
  style?: React.CSSProperties;
}) {
  const isMobile = useIsMobile();
  const lg = (size ?? (isMobile ? 'lg' : 'md')) === 'lg';
  const hint = options.find((o) => o.value === value)?.hint;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, ...style }}>
      <div role="radiogroup" aria-label={ariaLabel} style={{ display: 'flex', gap: 2, padding: 2, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'var(--color-base)' }}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => { if (!on) onChange(o.value); }}
              style={{
                flex: 1, minWidth: 0, height: lg ? 34 : 28, padding: '0 6px', border: 'none', cursor: 'pointer', borderRadius: 'var(--radius-sm)',
                fontSize: lg ? 13.5 : 12.5, fontWeight: on ? 600 : 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                background: on ? 'var(--color-elevated)' : 'transparent', color: on ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                boxShadow: on ? '0 1px 2px var(--color-shadow-strong)' : 'none',
              }}>
              {o.label}
            </button>
          );
        })}
      </div>
      {hint && <div aria-live="polite" style={{ fontSize: 12, lineHeight: 1.4, color: 'var(--color-text-tertiary)' }}>{hint}</div>}
    </div>
  );
}
