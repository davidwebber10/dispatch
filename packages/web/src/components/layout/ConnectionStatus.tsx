import { useConnection } from '../../stores/connection';

const STYLES = {
  open:       { color: 'var(--color-accent)', label: 'Connected' },
  connecting: { color: 'var(--color-status-yellow)', label: 'Reconnecting…' },
  closed:     { color: 'var(--color-status-red)', label: 'Disconnected' },
} as const;

export function ConnectionStatus() {
  const status = useConnection((s) => s.status);
  const st = STYLES[status];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      font: '500 11px var(--font-mono)', color: st.color,
    }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%', background: st.color,
        boxShadow: status === 'open' ? 'var(--shadow-glow)' : undefined,
        animation: status !== 'closed' ? 'dispatchConnPulse 2s ease-in-out infinite' : undefined,
      }} />
      {st.label}
    </span>
  );
}
