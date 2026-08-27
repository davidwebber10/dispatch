import { useState } from 'react';
import { CaretDown, CaretRight } from '@phosphor-icons/react';
import { useIsMobile } from '../../hooks/useIsMobile';

/**
 * A section's label row. Pass `onToggleCollapse` to make the label itself a disclosure
 * control, with a chevron directly right of it — the caller owns the collapsed state and
 * decides what to render below, so this component only reports the click.
 *
 * The label and chevron are ONE button rather than a bare chevron beside inert text: the
 * ARCHIVED shelf in the same card already toggles from anywhere on its header row, and a
 * FILES shelf that only responded to a 16px chevron would teach two different rules for
 * the same gesture. One element also keeps the control out of the nested-interactive trap
 * a clickable wrapper around the whole row would create (this row can also hold an add
 * button, supplied as `children`).
 */
export function SectionHeader({ label, count, prominent, collapsed, onToggleCollapse, children }: { label: string; count: number; prominent?: boolean; collapsed?: boolean; onToggleCollapse?: () => void; children?: React.ReactNode }) {
  const isMobile = useIsMobile();
  // On mobile all section labels share one bigger, brighter style so FILES
  // matches THREADS / AGENTS; on desktop the prominent/quiet tiers are kept.
  const labelStyle: React.CSSProperties = isMobile
    ? { font: '700 13px var(--font-mono)', letterSpacing: '1.3px', color: 'var(--color-text-secondary)' }
    : prominent
      ? { font: '700 11px var(--font-mono)', letterSpacing: '1.3px', color: 'var(--color-text-secondary)' }
      : { font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)' };
  // A collapsed shelf must still report its size: its rows are exactly what you can no
  // longer count for yourself. Open, a quiet section stays badge-free as before.
  const showCount = count > 0 && (prominent || collapsed);
  const badge = showCount && (
    <span style={{ font: `600 ${isMobile ? 11 : 9.5}px var(--font-mono)`, color: 'var(--color-text-secondary)', background: 'var(--color-elevated)', borderRadius: 9, padding: '0 6px', lineHeight: isMobile ? '17px' : '15px' }}>{count}</span>
  );
  const chevron = collapsed
    ? <CaretRight size={isMobile ? 13 : 11} weight="bold" style={{ flexShrink: 0, color: 'var(--color-text-tertiary)' }} />
    : <CaretDown size={isMobile ? 13 : 11} weight="bold" style={{ flexShrink: 0, color: 'var(--color-text-tertiary)' }} />;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: isMobile ? '12px 12px 6px' : (prominent ? '4px 6px 3px' : '2px 6px') }}>
      {onToggleCollapse ? (
        <button
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${label.toLowerCase()}`}
          aria-expanded={!collapsed}
          title={`${collapsed ? 'Expand' : 'Collapse'} ${label.toLowerCase()}`}
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: 0, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
        >
          <span style={labelStyle}>{label}</span>
          {badge}
          {chevron}
        </button>
      ) : (
        <>
          <span style={labelStyle}>{label}</span>
          {badge}
        </>
      )}
      <span style={{ flex: 1 }} />
      {children}
    </div>
  );
}

export function ShowMoreRow({ count, onClick }: { count: number; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const isMobile = useIsMobile();
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 6, width: '100%',
        padding: isMobile ? '12px' : '4px 9px', background: hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        border: 'none', borderRadius: isMobile ? 0 : 5, textAlign: 'left', cursor: 'pointer',
        color: hover ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)',
        fontSize: isMobile ? 14 : 11.5,
      }}
    >
      <CaretDown size={isMobile ? 13 : 11} style={{ flexShrink: 0 }} />
      Show {count} more
    </button>
  );
}
