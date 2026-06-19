import { useConnection } from '../../stores/connection';

const STYLES = {
  open:       { bg: 'var(--color-elevated)', border: '#2C2C32', color: 'var(--color-accent)', label: 'Connected' },
  connecting: { bg: '#241F12', border: '#4A3D18', color: 'var(--color-status-yellow)', label: 'Reconnecting…' },
  closed:     { bg: '#241313', border: '#4A1F22', color: 'var(--color-status-red)', label: 'Disconnected' },
} as const;

export function ConnectionStatus() {
  const status = useConnection((s) => s.status);
  const st = STYLES[status];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px',
      background: st.bg, border: `1px solid ${st.border}`, borderRadius: 7,
      font: '500 11px var(--font-mono)', color: st.color,
    }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%', background: st.color,
        boxShadow: status === 'open' ? 'var(--shadow-glow)' : undefined,
        animation: status === 'connecting' ? 'dispatchSpin 0.8s linear infinite' : undefined,
      }} />
      {st.label}
    </span>
  );
}
