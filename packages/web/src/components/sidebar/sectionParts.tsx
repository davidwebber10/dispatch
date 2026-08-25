import { useState } from 'react';
import { CaretDown } from '@phosphor-icons/react';
import { useIsMobile } from '../../hooks/useIsMobile';

export function SectionHeader({ label, count, prominent, children }: { label: string; count: number; prominent?: boolean; children?: React.ReactNode }) {
  const isMobile = useIsMobile();
  // On mobile all section labels share one bigger, brighter style so FILES
  // matches THREADS / AGENTS; on desktop the prominent/quiet tiers are kept.
  const labelStyle: React.CSSProperties = isMobile
    ? { font: '700 13px var(--font-mono)', letterSpacing: '1.3px', color: 'var(--color-text-secondary)' }
    : prominent
      ? { font: '700 11px var(--font-mono)', letterSpacing: '1.3px', color: 'var(--color-text-secondary)' }
      : { font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: isMobile ? '12px 12px 6px' : (prominent ? '4px 6px 3px' : '2px 6px') }}>
      <span style={labelStyle}>{label}</span>
      {prominent && count > 0 && (
        <span style={{ font: `600 ${isMobile ? 11 : 9.5}px var(--font-mono)`, color: 'var(--color-text-secondary)', background: 'var(--color-elevated)', borderRadius: 9, padding: '0 6px', lineHeight: isMobile ? '17px' : '15px' }}>{count}</span>
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
