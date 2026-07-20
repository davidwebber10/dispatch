/**
 * Shared presentational primitives for the settings sections.
 *
 * These used to live as module-private constants inside SettingsModal. They moved
 * here when the sections were split into standalone components so that both the
 * desktop modal and the mobile full-screen settings screens render identically.
 */

export const sectionLabel: React.CSSProperties = { font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)' };
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
