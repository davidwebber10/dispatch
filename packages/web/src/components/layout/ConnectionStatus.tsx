import { useShownStatus, type ShownStatus } from '../../stores/connection';
import { hostCopy } from '../../lib/hostCopy';

const STYLES = {
  open:       { color: 'var(--color-accent)', label: 'Connected' },
  connecting: { color: 'var(--color-status-yellow)', label: hostCopy('conn.connecting', 'Connecting…') },
  reconnecting: { color: 'var(--color-status-yellow)', label: hostCopy('conn.reconnecting', 'Reconnecting…') },
  closed:     { color: 'var(--color-status-red)', label: hostCopy('conn.closed', 'Disconnected') },
} as const;

/** `shown`: a status the caller already settled (its own grace period ran), so this one doesn't wait again. */
export function ConnectionStatus({ shown }: { shown?: ShownStatus } = {}) {
  const own = useShownStatus();
  const status = shown ?? own;
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
