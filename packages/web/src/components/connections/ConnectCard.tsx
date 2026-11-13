import { ArrowSquareOut, ArrowClockwise, PlugsConnected } from '@phosphor-icons/react';
import { PLATFORM_NAME } from '../../lib/hostCopy';
import { Button } from '../ui';
import { osLink, useOsConnections } from '../../stores/osConnections';

/**
 * "Connect <label>": one company system the person must connect in POLYWOOD OS before a thread can
 * use it. Connect opens OS in a new tab; Check again asks OS for the new state. The same card shows
 * in Settings > Accounts (Company connections) and under a tool row whose result says `not_connected`.
 */
export function ConnectCard({ label, connect, compact }: { label: string; connect: string | null; compact?: boolean }) {
  const osPublicUrl = useOsConnections((s) => s.state?.osPublicUrl ?? null);
  const checking = useOsConnections((s) => s.checking);
  const href = connect ? osLink(connect, osPublicUrl) : null;
  return (
    <div data-testid="connect-card" style={{
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      padding: compact ? '8px 12px' : '10px 14px', margin: compact ? '4px 20px 8px' : 0,
      border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', background: 'var(--color-elevated)',
    }}>
      <PlugsConnected size={16} style={{ flexShrink: 0, color: 'var(--color-text-secondary)' }} />
      <span style={{ flex: 1, minWidth: 160, fontSize: 13, color: 'var(--color-text-body)' }}>
        Connect {label} in {PLATFORM_NAME} so your threads can use it.
      </span>
      {href && (
        <Button variant="primary" size="sm" icon={<ArrowSquareOut size={13} />} onClick={() => window.open(href, '_blank', 'noopener')}>
          Connect {label}
        </Button>
      )}
      <Button variant="ghost" size="sm" icon={<ArrowClockwise size={13} />} disabled={checking} onClick={() => void useOsConnections.getState().checkAgain()}>
        {checking ? 'Checking…' : 'Check again'}
      </Button>
    </div>
  );
}
